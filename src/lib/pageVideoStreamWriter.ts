import { EventEmitter } from 'events';
import os from 'os';
import { extname } from 'path';
import { PassThrough, Writable } from 'stream';

import ffmpeg, { setFfmpegPath } from 'fluent-ffmpeg';

import {
  pageScreenFrame,
  SupportedFileFormats,
  VIDEO_WRITE_STATUS,
  VideoOptions,
} from './pageVideoStreamTypes';

/**
 * @ignore
 */
const SUPPORTED_FILE_FORMATS = [
  SupportedFileFormats.MP4,
  SupportedFileFormats.AVI,
  SupportedFileFormats.MOV,
  SupportedFileFormats.WEBM,
];

/**
 * @ignore
 */
export default class PageVideoStreamWriter extends EventEmitter {
  private readonly screenLimit = 10;
  private screenCastFrames = [];
  public duration = '00:00:00:00';
  public frameGain = 0;
  public frameLoss = 0;

  private status = VIDEO_WRITE_STATUS.NOT_STARTED;
  private options: VideoOptions;

  private videoMediatorStream: PassThrough = new PassThrough();
  private writerPromise: Promise<boolean>;

  constructor(destinationSource: string | Writable, options?: VideoOptions) {
    super();

    if (options) {
      this.options = options;
    }

    const isWritable = this.isWritableStream(destinationSource);
    this.configureFFmPegPath();
    if (isWritable) {
      this.configureVideoWritableStream(destinationSource as Writable);
    } else {
      this.configureVideoFile(destinationSource as string);
    }
  }

  private get videoFrameSize(): string {
    const { width, height } = this.options.videoFrame;

    return width !== null && height !== null ? `${width}x${height}` : '100%';
  }

  private get autopad(): { activation: boolean; color?: string } {
    const autopad = this.options.autopad;

    return !autopad
      ? { activation: false }
      : { activation: true, color: autopad.color };
  }

  private getFfmpegPath(): string | null {
    if (this.options.ffmpeg_Path) {
      return this.options.ffmpeg_Path;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('@ffmpeg-installer/ffmpeg');
      if (ffmpeg.path) {
        return ffmpeg.path;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  private getDestinationPathExtension(destinationFile): SupportedFileFormats {
    const fileExtension = extname(destinationFile);
    return fileExtension.includes('.')
      ? (fileExtension.replace('.', '') as SupportedFileFormats)
      : (fileExtension as SupportedFileFormats);
  }

  private configureFFmPegPath(): void {
    const ffmpegPath = this.getFfmpegPath();

    if (!ffmpegPath) {
      throw new Error(
        'FFmpeg path is missing, \n Set the FFMPEG_PATH env variable',
      );
    }

    setFfmpegPath(ffmpegPath);
  }

  private isWritableStream(destinationSource: string | Writable): boolean {
    if (destinationSource && typeof destinationSource !== 'string') {
      if (
        !(destinationSource instanceof Writable) ||
        !('writable' in destinationSource) ||
        !destinationSource.writable
      ) {
        throw new Error('Output should be a writable stream');
      }
      return true;
    }
    return false;
  }

  private configureVideoFile(destinationPath: string): void {
    const fileExt = this.getDestinationPathExtension(destinationPath);

    if (!SUPPORTED_FILE_FORMATS.includes(fileExt)) {
      throw new Error('File format is not supported');
    }

    this.writerPromise = new Promise((resolve) => {
      const outputStream = this.getDestinationStream();

      outputStream
        .on('error', (e) => {
          const errorMessage = e.stderr || e.message;
          console.error('FFmpeg error:', errorMessage);
          this.handleWriteStreamError(errorMessage);
          resolve(false);
        })
        .on('stderr', (e) => {
          this.handleWriteStreamError(e);
          resolve(false);
        })
        .on('end', () => resolve(true))
        .save(destinationPath);

      if (fileExt == SupportedFileFormats.WEBM) {
        outputStream
          .videoCodec('libvpx')
          .videoBitrate(this.options.videoBitrate || 1000, true)
          .outputOptions('-flags', '+global_header', '-psnr');
      }
    });
  }

  private configureVideoWritableStream(writableStream: Writable) {
    this.writerPromise = new Promise((resolve) => {
      const outputStream = this.getDestinationStream();

      outputStream
        .on('error', (e) => {
          const errorMessage = e.stderr || e.message;
          console.error('FFmpeg error:', errorMessage);
          writableStream.emit('error', e);
          resolve(false);
        })
        .on('stderr', (e) => {
          writableStream.emit('error', { message: e });
          resolve(false);
        })
        .on('end', () => {
          writableStream.end();
          resolve(true);
        });

      outputStream.toFormat('mp4');
      outputStream.addOutputOptions(
        '-movflags +frag_keyframe+separate_moof+omit_tfhd_offset+empty_moov',
      );
      outputStream.pipe(writableStream);
    });
  }

  private getOutputOption() {
    const cpu = Math.max(1, os.cpus().length - 1);
    const videoOutputOptions = this.options.videOutputOptions ?? [];

    const outputOptions = [];
    outputOptions.push(`-crf ${this.options.videoCrf ?? 23}`);
    outputOptions.push(`-preset ${this.options.videoPreset || 'ultrafast'}`);
    outputOptions.push(
      `-pix_fmt ${this.options.videoPixelFormat || 'yuv420p'}`,
    );
    outputOptions.push(`-minrate ${this.options.videoBitrate || 1000}`);
    outputOptions.push(`-maxrate ${this.options.videoBitrate || 1000}`);
    outputOptions.push('-framerate 1');
    outputOptions.push(`-threads ${cpu}`);
    outputOptions.push(`-loglevel error`);

    videoOutputOptions.forEach((options) => {
      outputOptions.push(options);
    });

    return outputOptions;
  }

  private addVideoMetadata(outputStream: ReturnType<typeof ffmpeg>) {
    const metadataOptions = this.options.metadata ?? [];

    for (const metadata of metadataOptions) {
      outputStream.outputOptions('-metadata', metadata);
    }
  }

  private getDestinationStream(): ffmpeg {
    const outputStream = ffmpeg({
      source: this.videoMediatorStream,
      priority: 20,
    })
      .videoCodec(this.options.videoCodec || 'libx264')
      .size(this.videoFrameSize)
      .aspect(this.options.aspectRatio || '4:3')
      .autopad(this.autopad.activation, this.autopad?.color)
      .inputFormat('image2pipe')
      .inputFPS(this.options.fps)
      .videoFilters('scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709')
      .outputOptions(this.getOutputOption())
      .outputOptions([
        '-colorspace', 'bt709',
        '-color_range', 'tv',
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709'
      ])
      .on('progress', (progressDetails) => {
        this.duration = progressDetails.timemark;
      });

    this.addVideoMetadata(outputStream);

    if (this.options.recordDurationLimit) {
      outputStream.duration(this.options.recordDurationLimit);
    }

    return outputStream;
  }

  private handleWriteStreamError(errorMessage): void {
    this.emit('videoStreamWriterError', errorMessage);

    if (
      this.status !== VIDEO_WRITE_STATUS.IN_PROGRESS &&
      errorMessage.includes('pipe:0: End of file')
    ) {
      return;
    }
    return console.error(
      `Error unable to capture video stream: ${errorMessage}`,
    );
  }

  private findSlot(timestamp: number): number {
    if (this.screenCastFrames.length === 0) {
      return 0;
    }

    let i: number;
    let frame: pageScreenFrame;

    for (i = this.screenCastFrames.length - 1; i >= 0; i--) {
      frame = this.screenCastFrames[i];

      if (timestamp > frame.timestamp) {
        break;
      }
    }

    return i + 1;
  }

  public insert(frame: pageScreenFrame): void {
    // reduce the queue into half when it is full
    if (this.screenCastFrames.length === this.screenLimit) {
      const numberOfFramesToSplice = Math.floor(this.screenLimit / 2);
      const framesToProcess = this.screenCastFrames.splice(
        0,
        numberOfFramesToSplice,
      );
      this.processFrameBeforeWrite(
        framesToProcess,
        this.screenCastFrames[0].timestamp,
      );
    }

    const insertionIndex = this.findSlot(frame.timestamp);

    if (insertionIndex === this.screenCastFrames.length) {
      this.screenCastFrames.push(frame);
    } else {
      this.screenCastFrames.splice(insertionIndex, 0, frame);
    }
  }

  private trimFrame(
    fameList: pageScreenFrame[],
    chunckEndTime: number,
  ): pageScreenFrame[] {
    return fameList.map((currentFrame: pageScreenFrame, index: number) => {
      const endTime =
        index !== fameList.length - 1
          ? fameList[index + 1].timestamp
          : chunckEndTime;
      const duration = endTime - currentFrame.timestamp;

      return {
        ...currentFrame,
        duration,
      };
    });
  }

  private processFrameBeforeWrite(
    frames: pageScreenFrame[],
    chunckEndTime: number,
  ): void {
    const processedFrames = this.trimFrame(frames, chunckEndTime);

    processedFrames.forEach(({ blob, duration }) => {
      this.write(blob, duration);
    });
  }

  public write(data: Buffer, durationSeconds = 1): void {
    this.status = VIDEO_WRITE_STATUS.IN_PROGRESS;

    const totalFrames = durationSeconds * this.options.fps;
    const floored = Math.floor(totalFrames);

    let numberOfFPS = Math.max(floored, 1);
    if (floored === 0) {
      this.frameGain += 1 - totalFrames;
    } else {
      this.frameLoss += totalFrames - floored;
    }

    while (1 < this.frameLoss) {
      this.frameLoss--;
      numberOfFPS++;
    }
    while (1 < this.frameGain) {
      this.frameGain--;
      numberOfFPS--;
    }

    for (let i = 0; i < numberOfFPS; i++) {
      this.videoMediatorStream.write(data);
    }
  }

  private drainFrames(stoppedTime: number): void {
    this.processFrameBeforeWrite(this.screenCastFrames, stoppedTime);
    this.screenCastFrames = [];
  }

  public stop(stoppedTime = Date.now() / 1000): Promise<boolean> {
    if (this.status === VIDEO_WRITE_STATUS.COMPLETED) {
      return this.writerPromise;
    }

    this.drainFrames(stoppedTime);

    this.videoMediatorStream.end();
    this.status = VIDEO_WRITE_STATUS.COMPLETED;
    return this.writerPromise;
  }
}
