declare module 'ws' {
  interface WebSocket extends EventTarget {
    readonly CONNECTING: number;
    readonly OPEN: number;
    readonly CLOSING: number;
    readonly CLOSED: number;
    readonly readyState: number;
    readonly protocol: string;
    readonly extensions: string;
    close(code?: number, reason?: string): void;
    send(data: string | ArrayBuffer | Uint8Array): void;
    terminate(): void;
    addEventListener(
      type: 'open' | 'error' | 'close' | 'message',
      listener: (event: Event | MessageEvent) => void,
    ): void;
    removeEventListener(
      type: 'open' | 'error' | 'close' | 'message',
      listener: (event: Event | MessageEvent) => void,
    ): void;
  }

  interface MessageEvent extends Event {
    readonly data: string | ArrayBuffer | Uint8Array;
  }

  interface CloseEvent extends Event {
    readonly wasClean: boolean;
    readonly code: number;
    readonly reason: string;
  }

  interface ErrorEvent extends Event {
    readonly error: any;
    readonly message: string;
  }

  export class WebSocket {
    constructor(url: string, protocols?: string | string[]);
    constructor(url: string, options?: any);
  }

  export default WebSocket;
}
