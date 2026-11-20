import { useMemo } from 'react';
import { api } from './api';
import { useApp } from './app';
import type { IncidentState } from '../types';

/** Drag-and-drop payload type for moving a person between voice rooms. */
export const PERSON_DRAG = 'application/x-warroom-person';

/** Room-control actions for the IC and room admins. Errors surface as toasts. */
export function useModeration(state: IncidentState) {
  const { toast, userById } = useApp();
  const inc = state.incident.id;
  return useMemo(() => {
    const name = (id: string) => userById(id)?.displayName ?? 'They';
    const fail = (e: unknown) => toast({ text: e instanceof Error ? e.message : 'That didn’t work', tone: 'error' }, 6000);
    return {
      can: state.canControl,
      move: async (userId: string, voiceRoomId: string) => {
        const room = state.voiceRooms.find((v) => v.id === voiceRoomId)?.name ?? 'the room';
        try {
          const r = await api.post<{ moved: boolean; invited: boolean }>(`/api/incidents/${inc}/voice/move`, { userId, voiceRoomId });
          if (r.moved) toast({ text: `Moved ${name(userId)} to ${room}` }, 3000);
          else if (r.invited) toast({ text: `${name(userId)} isn’t in voice — asked them to join ${room}` }, 4000);
        } catch (e) {
          fail(e);
        }
      },
      mute: async (userId: string) => {
        try {
          const r = await api.post<{ alreadyMuted?: boolean }>(`/api/incidents/${inc}/voice/mute`, { userId });
          toast({ text: r.alreadyMuted ? `${name(userId)} is already muted` : `Muted ${name(userId)}` }, 3000);
        } catch (e) {
          fail(e);
        }
      },
      cameraOff: async (userId: string) => {
        try {
          const r = await api.post<{ alreadyMuted?: boolean }>(`/api/incidents/${inc}/voice/camera`, { userId });
          toast({ text: r.alreadyMuted ? `${name(userId)}’s camera is already off` : `Turned off ${name(userId)}’s camera` }, 3000);
        } catch (e) {
          fail(e);
        }
      },
      remove: async (userId: string) => {
        try {
          await api.post(`/api/incidents/${inc}/voice/remove`, { userId });
          toast({ text: `Removed ${name(userId)} from voice` }, 3000);
        } catch (e) {
          fail(e);
        }
      },
    };
  }, [inc, state.canControl, state.voiceRooms, toast, userById]);
}
