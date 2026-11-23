import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { DashboardPanels, useDashboard } from '../components/DashboardView';
import { Icons } from '../components/ui';

/**
 * Wall mode: the war room dashboard full screen, for a TV in the room or a second monitor. Large
 * type, a live clock, refreshes on its own. It doesn't join the room, so it never shows up as a
 * person in it.
 */
export function Wall() {
  const { id = '' } = useParams();
  const { data, error } = useDashboard(id, false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (data) document.title = `${data.incident.key} · ${data.incident.statusLabel} · War Room`;
  }, [data]);

  return (
    <div className="wall-page">
      <div className="wall-tools">
        <Link className="btn ghost sm" to={`/incidents/${id}?view=dashboard`}>
          {Icons.back} Back to the war room
        </Link>
        <button className="btn ghost sm" onClick={() => void document.documentElement.requestFullscreen?.()}>
          {Icons.expand} Full screen
        </button>
      </div>
      {error && !data ? <div className="alert error">{error}</div> : !data ? <div className="skeleton" /> : <DashboardPanels data={data} now={now} wall />}
    </div>
  );
}
