import { useEffect, useState } from "react";
import { listVoices, onVoicesChanged, speak, speechSupported } from "../coach/voice";
import { videoExportSupported } from "../video/player";
import { useAppState } from "./state";

export function SettingsScreen() {
  const { settings, updateSettings, resetEverything, games, drills } = useAppState();
  const [voices, setVoices] = useState(listVoices());
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setVoices(listVoices());
    return onVoicesChanged(() => setVoices(listVoices()));
  }, []);

  return (
    <div className="screen">
      <section className="card">
        <h2>Analysis</h2>
        <label className="field">
          <span>
            Search depth: <strong>{settings.depth}</strong>
          </span>
          <input
            type="range"
            min={8}
            max={20}
            step={1}
            value={settings.depth}
            onChange={(event) => void updateSettings({ depth: Number(event.target.value) })}
          />
        </label>
        <p className="muted small">
          Depth 12 is quick and catches every blunder. Depth 18 finds subtler mistakes but roughly
          quadruples the time per move. Depth 14 is a good phone default.
        </p>

        <label className="field">
          <span>
            Lines considered per position: <strong>{settings.multiPv}</strong>
          </span>
          <input
            type="range"
            min={2}
            max={4}
            step={1}
            value={settings.multiPv}
            onChange={(event) => void updateSettings({ multiPv: Number(event.target.value) })}
          />
        </label>
        <p className="muted small">
          More lines let the app tell an &ldquo;only move&rdquo; from an easy one, at some cost in
          speed.
        </p>
      </section>

      <section className="card">
        <h2>Voice</h2>
        {speechSupported() ? (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={(event) => void updateSettings({ voiceEnabled: event.target.checked })}
              />
              <span>Speak explanations out loud</span>
            </label>

            <label className="field">
              <span>Voice</span>
              <select
                value={settings.voiceUri ?? ""}
                onChange={(event) =>
                  void updateSettings({ voiceUri: event.target.value || null })
                }
              >
                <option value="">Device default</option>
                {voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>
                Speed: <strong>{settings.voiceRate.toFixed(1)}×</strong>
              </span>
              <input
                type="range"
                min={0.6}
                max={1.6}
                step={0.1}
                value={settings.voiceRate}
                onChange={(event) => void updateSettings({ voiceRate: Number(event.target.value) })}
              />
            </label>

            <button
              type="button"
              className="button ghost"
              onClick={() =>
                speak(
                  "Knight takes d four loses your queen to bishop takes d four, check.",
                  { voiceUri: settings.voiceUri, rate: settings.voiceRate },
                )
              }
            >
              Test voice
            </button>
          </>
        ) : (
          <p className="muted">This browser has no speech synthesis, so narration is off.</p>
        )}
      </section>

      <section className="card">
        <h2>Board</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.boardFlipped}
            onChange={(event) => void updateSettings({ boardFlipped: event.target.checked })}
          />
          <span>Flip the board (view from the other side)</span>
        </label>
        <p className="muted small">
          By default the board is shown from your side of any given game.
        </p>
      </section>

      <section className="card">
        <h2>Claude coaching (optional)</h2>
        <p className="muted small">
          Everything in this app works without an API key. Turning this on adds a written review
          that explains the ideas behind your mistakes and ties them to your habits.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.claudeEnabled}
            onChange={(event) => void updateSettings({ claudeEnabled: event.target.checked })}
          />
          <span>Enable Claude coaching</span>
        </label>

        {settings.claudeEnabled && (
          <>
            <label className="field">
              <span>Anthropic API key</span>
              <input
                type={showKey ? "text" : "password"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                value={settings.anthropicApiKey}
                onChange={(event) =>
                  void updateSettings({ anthropicApiKey: event.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="button ghost small"
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? "Hide key" : "Show key"}
            </button>
            <p className="warning">
              The key is stored in this browser and sent only to api.anthropic.com. Because the
              request goes straight from the page, anything running on the page can read the key —
              fine for your own device, not safe on a shared or public deployment.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Stored data</h2>
        <p className="muted small">
          {games.length} game{games.length === 1 ? "" : "s"} and {drills.length} drill
          {drills.length === 1 ? "" : "s"} in this browser&apos;s storage. Nothing is uploaded
          anywhere.
        </p>
        <button
          type="button"
          className="button ghost danger"
          onClick={() => {
            if (window.confirm("Delete every stored game and drill? This cannot be undone.")) {
              void resetEverything();
            }
          }}
        >
          Delete all games and drills
        </button>
      </section>

      <section className="card">
        <h2>This device</h2>
        <ul className="capability-list">
          <Capability label="Speech synthesis" ok={speechSupported()} />
          <Capability label="Video export" ok={videoExportSupported()} />
          <Capability label="Offline storage" ok={typeof indexedDB !== "undefined"} />
        </ul>
      </section>
    </div>
  );
}

function Capability({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li>
      <span className={`capability-dot ${ok ? "ok" : "no"}`} />
      {label}: {ok ? "available" : "not available"}
    </li>
  );
}
