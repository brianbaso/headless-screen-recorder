import { EventEmitter } from 'events';

import { Page, CDPSession } from 'puppeteer';

import { PuppeteerScreenRecorderOptions } from './pageVideoStreamTypes';

/**
 * @ignore
 */
export class pageVideoStreamCollector extends EventEmitter {
  private page: Page;
  private options: PuppeteerScreenRecorderOptions;
  private isStreamingEnded = false;
  private intervalId: NodeJS.Timeout | null = null;
  private client: CDPSession | null = null;

  constructor(page: Page, options: PuppeteerScreenRecorderOptions) {
    super();
    this.page = page;
    this.options = options;
  }

  public async start(): Promise<void> {
    // Create CDP session once
    this.client = await this.page.target().createCDPSession();
    
    const quality = Number.isNaN(this.options.quality)
      ? 80
      : Math.max(Math.min(this.options.quality, 100), 0);

    const captureFrame = async () => {
      if (this.isStreamingEnded || !this.client) {
        return;
      }

      try {
        const result = await this.client.send('HeadlessExperimental.beginFrame', {
          screenshot: {
            format: this.options.format || 'jpeg',
            quality: quality,
          },
        });

        if (result.screenshotData) {
          this.emit('pageScreenFrame', {
            blob: Buffer.from(result.screenshotData, 'base64'),
            timestamp: Date.now() / 1000,
          });
        }
      } catch (error) {
        console.error('Error capturing frame:', error.message);
      }
    };

    // Calculate interval based on FPS (default 25 fps)
    const fps = this.options.fps || 25;
    const interval = 1000 / fps;

    // Start capturing frames
    this.intervalId = setInterval(captureFrame, interval);
  }

  public async stop(): Promise<boolean> {
    if (this.isStreamingEnded) {
      return true;
    }

    this.isStreamingEnded = true;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.client) {
      try {
        await this.client.detach();
      } catch (e) {
        console.warn('Error detaching CDP session:', e.message);
      }
      this.client = null;
    }

    return true;
  }
}