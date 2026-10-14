import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignInState } from '../src/lib/session.ts';
import { menuCommands } from '../src/pages/listen/menu.ts';

const signedIn = (issuer: boolean) => ({ status: 'signed_in', issuer }) as SignInState;
const labels = (signIn: SignInState) => menuCommands(signIn, () => undefined).map(command => command.label);

afterEach(() => vi.unstubAllGlobals());

describe('menuCommands', () => {
  it('offers Fullscreen only where the browser allows it', () => {
    vi.stubGlobal('document', { fullscreenEnabled: true });
    expect(labels({ status: 'checking' })).toEqual(['Fullscreen']);
    vi.stubGlobal('document', { fullscreenEnabled: false });
    expect(labels({ status: 'checking' })).toEqual([]);
  });

  it('offers Sign out only for a session that a configured issuer can bring back', () => {
    vi.stubGlobal('document', { fullscreenEnabled: false });
    expect(labels(signedIn(true))).toEqual(['Sign out']);
    expect(labels(signedIn(false))).toEqual([]);
    expect(labels({ status: 'signed_out', selfServe: false })).toEqual([]);
  });

  it('enters fullscreen, and leaves it when already fullscreen', async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const exitFullscreen = vi.fn(async () => undefined);
    const documentElement = { requestFullscreen };
    vi.stubGlobal('document', { fullscreenEnabled: true, fullscreenElement: null, documentElement, exitFullscreen });
    await menuCommands({ status: 'checking' }, () => undefined)[0]!.run();
    expect(requestFullscreen).toHaveBeenCalledOnce();
    vi.stubGlobal('document', { fullscreenEnabled: true, fullscreenElement: documentElement, documentElement, exitFullscreen });
    await menuCommands({ status: 'checking' }, () => undefined)[0]!.run();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});
