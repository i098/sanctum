/** What the listening page wires around the Menu: its commands, its shortcut, and which section it shows. */
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useState } from 'react';
import { signOut, type SignInState } from '../../lib/session.ts';
import type { MeetingRequest } from './MeetingsSection.tsx';
import type { MenuCommand } from './menu-search.ts';

/** The fixed commands the search box runs, besides opening each section. */
export function menuCommands(signIn: SignInState, refreshSignIn: () => void): ReadonlyArray<MenuCommand> {
  const signedInWithIssuer = signIn.status === 'signed_in' && signIn.issuer;
  return [
    ...(globalThis.document?.fullscreenEnabled
      ? [{ label: 'Fullscreen', run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }]
      : []),
    // Same rule as Settings: without a configured issuer the session is operator-seeded, and revoking it leaves no way back in.
    ...(signedInWithIssuer ? [{ label: 'Sign out', run: () => signOut().then(refreshSignIn) }] : []),
  ];
}

/** Ctrl/⌘+K opens `menu` unless another overlay is already open. */
export function useMenuShortcut<O>(button: RefObject<HTMLElement | null>, setOverlay: Dispatch<SetStateAction<O | null>>, menu: NoInfer<O>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Lowercase: Caps Lock (or Shift) reports an uppercase K.
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      // Focus first: a native dialog returns focus to whatever had it when it opened.
      button.current?.focus();
      setOverlay(open => open ?? menu);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [button, setOverlay, menu]);
}

/**
 * The shown section, and a search result's meeting that Meetings opens. Any other
 * way into a section, or closing the Menu, clears that meeting.
 */
export function useMenuSection(menuOpen: boolean, first: string) {
  const [section, setSection] = useState(first);
  const [chosenMeeting, setChosenMeeting] = useState<MeetingRequest | undefined>();
  useEffect(() => {
    if (!menuOpen) setChosenMeeting(undefined);
  }, [menuOpen]);
  const select = useCallback((id: string) => (setChosenMeeting(undefined), setSection(id)), []);
  const openMeeting = useCallback((id: string) => (setChosenMeeting({ id }), setSection('meetings')), []);
  return { section, chosenMeeting, select, openMeeting };
}
