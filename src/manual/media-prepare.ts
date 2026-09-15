import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * 投稿画面で添付された画像・動画を、4つのSNSすべてが受け付ける形に整える（自分のPCで実行）。
 *
 * - 画像: JPEG に変換する（Instagram は JPEG のみ。Bluesky は 2,000,000 バイトまで）
 * - 動画: MP4（H.264 / AAC）に揃える。合っていなければ ffmpeg で変換する
 *   （Threads は横幅1920px・23〜60fps まで。Bluesky は MP4 を前提にしている）
 */

const IMAGE_MAX_BYTES = 1_900_000;
const IMAGE_MAX_EDGE = 2048;
const IMAGE_QUALITY_STEPS = [90, 82, 74, 66, 58];

const VIDEO_MAX_WIDTH = 1920;

export interface PreparedMedia {
  kind: 'image' | 'video';
  /** 変換後の一時ファイル。使い終わったら cleanup() で消す。 */
  filePath: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  durationSec?: number;
  /** 形式を変換したか（画面に知らせるため） */
  converted: boolean;
  cleanup(): Promise<void>;
}

export async function prepareMedia(
  data: Buffer,
  kind: 'image' | 'video',
  id: string,
): Promise<PreparedMedia> {
  const dir = await mkdtemp(join(tmpdir(), 'manual-post-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const prepared = kind === 'image' ? await prepareImage(data, dir, id) : await prepareVideo(data, dir, id);
    return { ...prepared, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function prepareImage(data: Buffer, dir: string, id: string): Promise<Omit<PreparedMedia, 'cleanup'>> {
  for (const quality of IMAGE_QUALITY_STEPS) {
    const { data: jpeg, info } = await sharp(data)
      .rotate()
      .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // 透過画像が黒くつぶれないように白背景を敷く
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (jpeg.byteLength <= IMAGE_MAX_BYTES) {
      const fileName = `image-${id}.jpg`;
      const filePath = join(dir, fileName);
      await writeFile(filePath, jpeg);
      return {
        kind: 'image',
        filePath,
        fileName,
        mimeType: 'image/jpeg',
        bytes: jpeg.byteLength,
        width: info.width,
        height: info.height,
        converted: true,
      };
    }
  }
  throw new Error('画像を2MB以下に圧縮できませんでした。');
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`${command} が見つかりません。動画を扱うには ffmpeg のインストールが必要です。`));
            return;
          }
          const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
          reject(new Error(`${command} でエラーが起きました: ${tail || error.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

interface ProbeResult {
  formatName: string;
  durationSec: number;
  videoCodec: string;
  pixFmt: string;
  /** 回転を反映した、見た目どおりの幅と高さ */
  width: number;
  height: number;
  fps: number;
  audioCodec: string | null;
}

async function probeVideo(path: string): Promise<ProbeResult> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const json = JSON.parse(out) as {
    format?: { format_name?: string; duration?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      disposition?: { attached_pic?: number };
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !video.width || !video.height) {
    throw new Error('動画の映像を読み取れませんでした。動画ファイルかどうか確認してください。');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  const rotation =
    video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;

  const [num, den] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;

  return {
    formatName: json.format?.format_name ?? '',
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: video.codec_name ?? '',
    pixFmt: video.pix_fmt ?? '',
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps,
    audioCodec: audio?.codec_name ?? null,
  };
}

async function prepareVideo(data: Buffer, dir: string, id: string): Promise<Omit<PreparedMedia, 'cleanup'>> {
  const input = join(dir, 'input');
  await writeFile(input, data);
  const probe = await probeVideo(input);

  const needsTranscode =
    !probe.formatName.includes('mp4') ||
    probe.videoCodec !== 'h264' ||
    probe.pixFmt !== 'yuv420p' ||
    (probe.audioCodec !== null && probe.audioCodec !== 'aac') ||
    probe.width > VIDEO_MAX_WIDTH ||
    (probe.fps > 0 && (probe.fps > 60 || probe.fps < 23));

  const fileName = `video-${id}.mp4`;
  const output = join(dir, fileName);

  if (needsTranscode) {
    const filters: string[] = [];
    if (probe.width > VIDEO_MAX_WIDTH) filters.push(`scale=${VIDEO_MAX_WIDTH}:-2`);
    const args = ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?'];
    if (filters.length) args.push('-vf', filters.join(','));
    if (probe.fps > 60 || (probe.fps > 0 && probe.fps < 23)) args.push('-r', '30');
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      output,
    );
    await run('ffmpeg', args);
  } else {
    // 形式は合っているので、変換せずに入れ物だけ MP4 に詰め直す。
    // faststart にしておくと、Meta 側がファイルの先頭から情報を読めて処理が速い。
    await run('ffmpeg', ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', output]);
  }

  const final = await probeVideo(output);
  const { size } = await stat(output);
  return {
    kind: 'video',
    filePath: output,
    fileName,
    mimeType: 'video/mp4',
    bytes: size,
    width: final.width,
    height: final.height,
    durationSec: final.durationSec,
    converted: needsTranscode,
  };
}
