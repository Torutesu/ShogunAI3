/** Inner payload for `app_settings_load` mock / Tauri success body. */
export interface SettingsLoadResponse {
  settings: { sections: Record<string, Record<string, unknown>> };
  echo: unknown;
  stub: false;
}

/** Inner payload for `app_settings_save` mock / Tauri success body. */
export interface SettingsSaveResponse {
  saved: true;
  stub: false;
  echo: unknown;
}

/** Standard ipc-client.invoke() success envelope wrapping mock/Tauri data. */
export interface IpcSuccessEnvelope<T> {
  ok: true;
  data: T;
  request: { command: string; payload: unknown };
}
