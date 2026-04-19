/* global window */
/**
 * Persists across navigations so the top HUD + MediaRecorder survive leaving Meetings.
 * Depends on window.MeetingNoteLocal (meeting-note-local.js).
 */
(function initMeetingMediaRecording(global) {
  var mediaRecorder = null;
  var mediaStream = null;
  var mediaChunks = [];
  var skipOutput = false;
  var storageKeyRef = null;
  var titleRef = 'Untitled';
  var startedAtRef = 0;

  function fmtElapsedMs(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return String(m) + ':' + String(sec).padStart(2, '0');
  }

  function emitHud(active, title, startedAt) {
    try {
      global.dispatchEvent(
        new CustomEvent('shogun-meeting-hud', {
          detail: {
            active: !!active,
            title: title || 'Untitled',
            startedAt: startedAt || 0,
            storageKey: storageKeyRef || null,
          },
        }),
      );
    } catch (_e) {
      /* ignore */
    }
  }

  function cleanupTracks() {
    var s = mediaStream;
    if (s) {
      try {
        s.getTracks().forEach(function (t) {
          t.stop();
        });
      } catch (_e) {}
      mediaStream = null;
    }
    mediaRecorder = null;
    mediaChunks = [];
  }

  function isRecording() {
    return !!(mediaRecorder && mediaRecorder.state === 'recording');
  }

  function getStartedAt() {
    return startedAtRef || 0;
  }

  /** While recording, the note `storageKey` passed to `start()` (for UI: single active row). */
  function getActiveStorageKey() {
    return isRecording() ? storageKeyRef : null;
  }

  function stop() {
    skipOutput = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        if (typeof mediaRecorder.requestData === 'function') {
          mediaRecorder.requestData();
        }
      } catch (_e0) {}
      try {
        mediaRecorder.stop();
      } catch (_e) {}
    } else {
      cleanupTracks();
      emitHud(false);
    }
  }

  function abort() {
    skipOutput = true;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        if (typeof mediaRecorder.requestData === 'function') {
          mediaRecorder.requestData();
        }
      } catch (_e0) {}
      try {
        mediaRecorder.stop();
      } catch (_e) {}
    } else {
      cleanupTracks();
      emitHud(false);
      skipOutput = false;
    }
  }

  async function start(opts) {
    if (!opts || !opts.storageKey) return { ok: false, error: 'no_storage_key' };
    if (isRecording()) return { ok: false, error: 'already_recording' };
    if (!global.navigator.mediaDevices || typeof global.MediaRecorder === 'undefined') {
      return { ok: false, error: 'no_mediarecorder' };
    }
    storageKeyRef = opts.storageKey;
    titleRef = (opts.title && String(opts.title).trim()) || 'Untitled';

    try {
      var stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream = stream;
      mediaChunks = [];
      var mime = '';
      var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (var i = 0; i < candidates.length; i++) {
        if (global.MediaRecorder.isTypeSupported(candidates[i])) {
          mime = candidates[i];
          break;
        }
      }
      var mr = mime ? new global.MediaRecorder(stream, { mimeType: mime }) : new global.MediaRecorder(stream);
      mediaRecorder = mr;

      mr.ondataavailable = function (e) {
        if (e.data && e.data.size) mediaChunks.push(e.data);
      };
      mr.onerror = function () {
        if (typeof opts.onToast === 'function') opts.onToast('録音エラーが発生しました', 'warn');
      };
      mr.onstop = function () {
        var skip = skipOutput;
        skipOutput = false;
        var startedAt = startedAtRef;
        var type = mr.mimeType || 'audio/webm';
        var chunks = mediaChunks.slice();
        var sk = storageKeyRef;
        var title = titleRef;
        storageKeyRef = null;
        startedAtRef = 0;
        mediaChunks = [];
        cleanupTracks();
        emitHud(false);

        try {
          global.dispatchEvent(new CustomEvent('shogun-meeting-recording-ended'));
        } catch (_e2) {}

        if (skip) {
          if (typeof opts.onToast === 'function') opts.onToast('録音を破棄しました', 'info');
          return;
        }
        try {
          var blob = new global.Blob(chunks, { type: type });
          var durationMs = Math.max(0, Date.now() - startedAt);
          var durStr = fmtElapsedMs(durationMs);
          var ext = type.indexOf('mp4') !== -1 ? 'm4a' : 'webm';
          var fname = 'meeting-note-' + String(startedAt) + '.' + ext;
          var url = global.URL.createObjectURL(blob);
          var a = global.document.createElement('a');
          a.href = url;
          a.download = fname;
          a.rel = 'noopener';
          global.document.body.appendChild(a);
          a.click();
          a.remove();
          global.setTimeout(function () {
            global.URL.revokeObjectURL(url);
          }, 4000);

          var L = global.MeetingNoteLocal;
          if (L && sk) {
            var prev = L.loadNote(sk) || {};
            var line = '\n\n---\n[録音 ' + durStr + '] 音声ファイル: ' + fname + '（ダウンロード済み）\n';
            L.saveNote(sk, {
              transcript: (prev.transcript || '') + line,
            });
          }

          var durationLabel =
            durationMs < 60000
              ? Math.max(1, Math.round(durationMs / 1000)) + 's'
              : Math.max(1, Math.round(durationMs / 60000)) + 'm';
          if (L && L.prependMeetingLogEntry) {
            L.prependMeetingLogEntry({
              t: title || 'Untitled',
              a: 'solo · local',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              tag: 'AUDIO',
              duration: durationLabel,
              storageKey: sk,
              dateCtx: 'today-user',
            });
          }
          try {
            global.dispatchEvent(new CustomEvent('shogun-user-meeting-log-changed'));
          } catch (_e3) {}

          if (typeof opts.onToast === 'function') {
            opts.onToast('録音を終了しました（' + durStr + '）。ファイルを保存しました', 'success');
          }
        } catch (_err) {
          if (typeof opts.onToast === 'function') opts.onToast('録音の保存に失敗しました', 'warn');
        }
      };

      startedAtRef = Date.now();
      emitHud(true, titleRef, startedAtRef);
      try {
        mr.start(400);
      } catch (_e2) {
        cleanupTracks();
        storageKeyRef = null;
        startedAtRef = 0;
        emitHud(false);
        if (typeof opts.onToast === 'function') {
          opts.onToast('録音を開始できませんでした（コーデック非対応の可能性）', 'warn');
        }
        return { ok: false, error: 'start_failed' };
      }
      if (typeof opts.onToast === 'function') {
        opts.onToast('ミーティング録音を開始しました（マイク）', 'success');
      }
      return { ok: true };
    } catch (_e) {
      cleanupTracks();
      emitHud(false);
      if (typeof opts.onToast === 'function') {
        opts.onToast('マイクの許可が必要です（ブラウザの設定を確認）', 'warn');
      }
      return { ok: false, error: 'mic_denied' };
    }
  }

  global.MeetingMediaRecording = {
    start: start,
    stop: stop,
    abort: abort,
    isRecording: isRecording,
    getStartedAt: getStartedAt,
    getActiveStorageKey: getActiveStorageKey,
  };
})(window);
