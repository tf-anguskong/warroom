import { useEffect, useState } from 'react';
import { onSoundsChanged, setSoundsOn, soundsOn } from '../lib/sounds';
import { Icons } from './ui';

/** Bell in the top bar: notification sounds on or off for this browser. */
export function SoundToggle() {
  const [on, setOn] = useState(soundsOn);
  useEffect(() => onSoundsChanged(setOn), []);
  return (
    <button
      className={`icon-btn ${on ? '' : 'sound-off'}`}
      onClick={() => setSoundsOn(!on)}
      aria-pressed={on}
      title={on ? 'Notification sounds on (people joining or leaving voice, calls to a room, @mentions). Click to mute.' : 'Notification sounds off. Click to turn them on.'}
      aria-label={on ? 'Mute notification sounds' : 'Turn on notification sounds'}
    >
      {on ? Icons.bell : Icons.bellOff}
    </button>
  );
}
