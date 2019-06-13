// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PageConfig, URLExt } from '@jupyterlab/coreutils';

import { ArrayExt, each, map, toArray } from '@phosphor/algorithm';

import { JSONPrimitive } from '@phosphor/coreutils';

import { ISignal, Signal } from '@phosphor/signaling';

import { ServerConnection } from '../serverconnection';

import { WSConnection } from '../wsconnection';

import { TerminalSession } from './terminal';

/**
 * The url for the terminal service.
 */
const TERMINAL_SERVICE_URL = 'api/terminals';

/**
 * An implementation of a terminal interface.
 */
export class DefaultTerminalSession
  extends WSConnection<JSONPrimitive[], JSONPrimitive[]>
  implements TerminalSession.ISession {
  /**
   * Construct a new terminal session.
   */
  constructor(name: string, options: TerminalSession.IOptions = {}) {
    super();
    this._name = name;
    this.serverSettings =
      options.serverSettings || ServerConnection.makeSettings();
    this._createSocket();
  }

  /**
   * A signal emitted when the session is shut down.
   */
  get terminated(): Signal<this, void> {
    return this._terminated;
  }

  /**
   * A signal emitted when a message is received from the server.
   */
  get messageReceived(): ISignal<this, TerminalSession.IMessage> {
    return this._messageReceived;
  }

  /**
   * Get the name of the terminal session.
   */
  get name(): string {
    return this._name;
  }

  /**
   * Get the model for the terminal session.
   */
  get model(): TerminalSession.IModel {
    return { name: this._name };
  }

  /**
   * The server settings for the session.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * Dispose of the resources held by the session.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.terminated.emit(undefined);
    super.dispose();
    delete Private.running[this._url];
    Signal.clearData(this);
  }

  /**
   * Send a message to the terminal session.
   */
  send(message: TerminalSession.IMessage): void {
    if (this.isDisposed || !message.content) {
      return;
    }

    const msg = [message.type, ...message.content];
    this.sendMessage(msg);
  }

  /**
   * Reconnect to the terminal.
   *
   * @returns A promise that resolves when the terminal has reconnected.
   */
  reconnect(): Promise<void> {
    this.reconnectAttempt = 0;
    this._createSocket();
    return this.ready;
  }

  /**
   * Shut down the terminal session.
   */
  shutdown(): Promise<void> {
    const { name, serverSettings } = this;
    return DefaultTerminalSession.shutdown(name, serverSettings);
  }

  /**
   * Clone the current session object.
   */
  clone(): TerminalSession.ISession {
    const { name, serverSettings } = this;
    return new DefaultTerminalSession(name, { serverSettings });
  }

  protected wsFactory() {
    const settings = this.serverSettings;
    const token = this.serverSettings.token;

    this._url = Private.getTermUrl(settings.baseUrl, this._name);
    Private.running[this._url] = this;

    let wsUrl = URLExt.join(settings.wsUrl, `terminals/websocket/${name}`);

    if (token) {
      wsUrl = wsUrl + `?token=${encodeURIComponent(token)}`;
    }

    return new settings.WebSocket(wsUrl);
  }

  protected handleMessage(data: JSONPrimitive[]): boolean {
    if (this.reconnectAttempt > 0) {
      // After reconnection, ignore all messages until a 'setup' message.
      if (data[0] === 'setup') {
        this.reconnectAttempt = 0;
      }
      return;
    }

    this._messageReceived.emit({
      type: data[0] as TerminalSession.MessageType,
      content: data.slice(1)
    });
  }

  private _messageReceived = new Signal<this, TerminalSession.IMessage>(this);
  private _terminated = new Signal<this, void>(this);
  private _name: string;
  private _url: string;
}

/**
 * The static namespace for `DefaultTerminalSession`.
 */
export namespace DefaultTerminalSession {
  /**
   * Whether the terminal service is available.
   */
  export function isAvailable(): boolean {
    let available = String(PageConfig.getOption('terminalsAvailable'));
    return available.toLowerCase() === 'true';
  }

  /**
   * Start a new terminal session.
   *
   * @param options - The session options to use.
   *
   * @returns A promise that resolves with the session instance.
   */
  export function startNew(
    options: TerminalSession.IOptions = {}
  ): Promise<TerminalSession.ISession> {
    if (!TerminalSession.isAvailable()) {
      throw Private.unavailableMsg;
    }
    let serverSettings =
      options.serverSettings || ServerConnection.makeSettings();
    let url = Private.getServiceUrl(serverSettings.baseUrl);
    let init = { method: 'POST' };

    return ServerConnection.makeRequest(url, init, serverSettings)
      .then(response => {
        if (response.status !== 200) {
          throw new ServerConnection.ResponseError(response);
        }
        return response.json();
      })
      .then((data: TerminalSession.IModel) => {
        let name = data.name;
        return new DefaultTerminalSession(name, { ...options, serverSettings });
      });
  }

  /*
   * Connect to a running session.
   *
   * @param name - The name of the target session.
   *
   * @param options - The session options to use.
   *
   * @returns A promise that resolves with the new session instance.
   *
   * #### Notes
   * If the session was already started via `startNew`, the existing
   * session object is used as the fulfillment value.
   *
   * Otherwise, if `options` are given, we resolve the promise after
   * confirming that the session exists on the server.
   *
   * If the session does not exist on the server, the promise is rejected.
   */
  export function connectTo(
    name: string,
    options: TerminalSession.IOptions = {}
  ): Promise<TerminalSession.ISession> {
    if (!TerminalSession.isAvailable()) {
      return Promise.reject(Private.unavailableMsg);
    }
    let serverSettings =
      options.serverSettings || ServerConnection.makeSettings();
    let url = Private.getTermUrl(serverSettings.baseUrl, name);
    if (url in Private.running) {
      return Promise.resolve(Private.running[url].clone());
    }
    return listRunning(serverSettings).then(models => {
      let index = ArrayExt.findFirstIndex(models, model => {
        return model.name === name;
      });
      if (index !== -1) {
        let session = new DefaultTerminalSession(name, {
          ...options,
          serverSettings
        });
        return Promise.resolve(session);
      }
      return Promise.reject<TerminalSession.ISession>('Could not find session');
    });
  }

  /**
   * List the running terminal sessions.
   *
   * @param settings - The server settings to use.
   *
   * @returns A promise that resolves with the list of running session models.
   */
  export function listRunning(
    settings?: ServerConnection.ISettings
  ): Promise<TerminalSession.IModel[]> {
    if (!TerminalSession.isAvailable()) {
      return Promise.reject(Private.unavailableMsg);
    }
    settings = settings || ServerConnection.makeSettings();
    let url = Private.getServiceUrl(settings.baseUrl);
    return ServerConnection.makeRequest(url, {}, settings)
      .then(response => {
        if (response.status !== 200) {
          throw new ServerConnection.ResponseError(response);
        }
        return response.json();
      })
      .then((data: TerminalSession.IModel[]) => {
        if (!Array.isArray(data)) {
          throw new Error('Invalid terminal data');
        }
        // Update the local data store.
        let urls = toArray(
          map(data, item => {
            return URLExt.join(url, item.name);
          })
        );
        each(Object.keys(Private.running), runningUrl => {
          if (urls.indexOf(runningUrl) === -1) {
            let session = Private.running[runningUrl];
            session.dispose();
          }
        });
        return data;
      });
  }

  /**
   * Shut down a terminal session by name.
   *
   * @param name - The name of the target session.
   *
   * @param settings - The server settings to use.
   *
   * @returns A promise that resolves when the session is shut down.
   */
  export function shutdown(
    name: string,
    settings?: ServerConnection.ISettings
  ): Promise<void> {
    if (!TerminalSession.isAvailable()) {
      return Promise.reject(Private.unavailableMsg);
    }
    settings = settings || ServerConnection.makeSettings();
    let url = Private.getTermUrl(settings.baseUrl, name);
    let init = { method: 'DELETE' };
    return ServerConnection.makeRequest(url, init, settings).then(response => {
      if (response.status === 404) {
        return response.json().then(data => {
          console.warn(data['message']);
        });
      }
      if (response.status !== 204) {
        throw new ServerConnection.ResponseError(response);
      }
    });
  }

  /**
   * Shut down all terminal sessions.
   *
   * @param settings - The server settings to use.
   *
   * @returns A promise that resolves when all the sessions are shut down.
   */
  export async function shutdownAll(
    settings?: ServerConnection.ISettings
  ): Promise<void> {
    settings = settings || ServerConnection.makeSettings();
    const running = await listRunning(settings);
    await Promise.all(running.map(s => shutdown(s.name, settings)));
  }
}

/**
 * A namespace for private data.
 */
namespace Private {
  /**
   * A mapping of running terminals by url.
   */
  export const running: {
    [key: string]: DefaultTerminalSession;
  } = Object.create(null);

  /**
   * A promise returned for when terminals are unavailable.
   */
  export const unavailableMsg = 'Terminals Unavailable';

  /**
   * Get the url for a terminal.
   */
  export function getTermUrl(baseUrl: string, name: string): string {
    return URLExt.join(baseUrl, TERMINAL_SERVICE_URL, name);
  }

  /**
   * Get the base url.
   */
  export function getServiceUrl(baseUrl: string): string {
    return URLExt.join(baseUrl, TERMINAL_SERVICE_URL);
  }
}
