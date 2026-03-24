declare module 'jmuxer' {
  interface JMuxerOptions {
    node: string | HTMLVideoElement;
    mode?: 'video' | 'audio' | 'both';
    flushingTime?: number;
    fps?: number;
    debug?: boolean;
    onReady?: () => void;
    onError?: (e: any) => void;
  }

  interface FeedData {
    video?: Uint8Array;
    audio?: Uint8Array;
    duration?: number;
  }

  export default class JMuxer {
    constructor(options: JMuxerOptions);
    feed(data: FeedData): void;
    destroy(): void;
  }
}
