"use client";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { ErrorNotice } from "./ui";
type DoorOption = {
  id: string;
  name: string;
  status: "online" | "offline" | "unknown";
};
export function RingDoorPicker({
  mode,
  csrf,
  owner,
  onSelected,
}: {
  mode: string;
  csrf: string;
  owner: boolean;
  onSelected: () => void;
}) {
  const [status, setStatus] = useState("Checking integration state…"),
    [doors, setDoors] = useState<DoorOption[]>([]),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    api<{ status: string; selectedDeviceId?: string }>("/ring/status")
      .then((value) => {
        if (!active) return;
        const labels: Record<string, string> = {
          LOCAL_SIMULATION: "Local simulation only",
          LINKED: "Account linked",
          UNLINKED: "Account not linked",
          REVOKED: "Access revoked",
          LINKING: "Linking needs confirmation",
        };
        setStatus(labels[value.status] || "Connection not confirmed");
        setSelected(value.selectedDeviceId || "");
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [mode]);
  async function discover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ devices: DoorOption[] }>("/ring/devices");
      setDoors(result.devices);
      setNotice(
        result.devices.length
          ? "Choose one authorized Ring door below."
          : "Ring returned no available doors. Text remains available.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function choose() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/ring/select-door", { body: { deviceId: selected }, csrf });
      setNotice(
        "Your selected Ring door was saved. Open incoming media separately when handling a visit.",
      );
      onSelected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ring-door-picker">
      <p className="small">
        <strong>{status}</strong>
      </p>
      <ErrorNotice message={error} />
      {notice ? <p role="status">{notice}</p> : null}
      {mode !== "demo" ? (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !owner}
            onClick={() => void discover()}
          >
            Read authorized Ring doors
          </button>
          {doors.length ? (
            <div>
              <label className="field">
                <span>Selected Ring door</span>
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Choose a door</option>
                  {doors.map((door) => (
                    <option key={door.id} value={door.id}>
                      {door.name} · {door.status}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected || !owner}
                onClick={() => void choose()}
              >
                Use this Ring door
              </button>
            </div>
          ) : null}
          <p className="small muted">
            Device discovery runs only when you choose it. Offline or encrypted
            media may be unavailable; visitor text remains separate.
          </p>
        </>
      ) : null}
    </div>
  );
}
