import { describe, it, expect, vi } from 'vitest';

import {
  RemoteBindRefused,
  bindWithExposureGate,
  describeExposure,
  remoteBindRefusal,
  type BindTarget,
} from '../../src/gui/remote-exposure.js';

/**
 * Binding the GUI to anything other than the loopback publishes an
 * UNAUTHENTICATED read/write surface to the network. Two things have to be true
 * before that is allowed to happen:
 *
 *   - the root was NAMED. Inferring which data to publish is not a decision a
 *     program gets to make on someone's behalf.
 *   - the operator was told, in plain terms, WHICH root and WHICH workspace is
 *     about to be served, and said yes. A warning about risk in the abstract is
 *     what let a wrong workspace through unnoticed.
 */

function target(over: Partial<BindTarget> = {}): BindTarget {
  return {
    host: '0.0.0.0',
    port: 4317,
    allowRemote: true,
    assumeYes: false,
    rootSource: 'explicit',
    root: '/named/.lattice',
    workspace: { displayName: 'Notes', kind: 'local', configPath: '/named/w/workspace.yml' },
    ...over,
  };
}

/** Collects output and answers the prompt with a canned reply. */
function io(answer?: string): {
  lines: string[];
  log: (l: string) => void;
  prompt?: (q: string) => Promise<string>;
  prompted: string[];
} {
  const lines: string[] = [];
  const prompted: string[] = [];
  return {
    lines,
    prompted,
    log: (l: string) => lines.push(l),
    ...(answer === undefined
      ? {}
      : {
          prompt: (q: string): Promise<string> => {
            prompted.push(q);
            return Promise.resolve(answer);
          },
        }),
  };
}

describe('remoteBindRefusal', () => {
  it('allows any loopback bind', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.5.6.7']) {
      expect(
        remoteBindRefusal(target({ host, allowRemote: false, rootSource: 'home' })),
      ).toBeNull();
    }
  });

  it('refuses a non-loopback bind without the explicit opt-in', () => {
    const why = remoteBindRefusal(target({ allowRemote: false }));
    expect(why).toContain('--allow-remote');
    expect(why).toContain('UNAUTHENTICATED');
  });

  it('refuses a non-loopback bind when the root was only inferred', () => {
    const why = remoteBindRefusal(target({ rootSource: 'home' }));
    expect(why).toContain('--root');
  });

  it('accepts a non-loopback bind whose root was named on the command line or in the environment', () => {
    expect(remoteBindRefusal(target({ rootSource: 'explicit' }))).toBeNull();
    expect(remoteBindRefusal(target({ rootSource: 'env' }))).toBeNull();
  });

  it('decides from the bind alone, so it can run before any root is resolved', () => {
    // A bind that is going to be refused must not first create or open
    // anything — the caller runs this as a preflight, holding nothing but the
    // flags. Passing only those three fields has to type-check and work.
    const preflight = { host: '0.0.0.0', allowRemote: true, rootSource: 'home' } as const;
    expect(remoteBindRefusal(preflight)).toContain('--root');
  });
});

describe('describeExposure', () => {
  it('names the resolved root, the workspace, and that there is no login', () => {
    const text = describeExposure(target()).join('\n');
    expect(text).toContain('/named/.lattice');
    expect(text).toContain('Notes');
    expect(text).toContain('/named/w/workspace.yml');
    expect(text).toContain('0.0.0.0:4317');
    expect(text).toMatch(/unauthenticated|no login/i);
  });

  it('says prominently when the workspace being published is a cloud workspace', () => {
    const text = describeExposure(
      target({
        workspace: { displayName: 'Acme', kind: 'cloud', configPath: '/named/w/workspace.yml' },
      }),
    ).join('\n');
    expect(text).toContain('CLOUD');
    // The point of saying it: the data at risk is not only this machine's.
    expect(text).toMatch(/shared|remote database|other people/i);
  });

  it('is explicit when there is no workspace to serve yet', () => {
    const text = describeExposure(target({ workspace: null })).join('\n');
    expect(text).toMatch(/no workspace/i);
  });
});

describe('bindWithExposureGate', () => {
  it('binds loopback with no disclosure and no prompt', async () => {
    const o = io('y');
    const listen = vi.fn().mockResolvedValue('handle');
    await expect(bindWithExposureGate(target({ host: '127.0.0.1' }), o, listen)).resolves.toBe(
      'handle',
    );
    expect(o.lines).toEqual([]);
    expect(o.prompted).toEqual([]);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('never listens when the root was not named', async () => {
    const o = io('y');
    const listen = vi.fn().mockResolvedValue('handle');
    await expect(bindWithExposureGate(target({ rootSource: 'home' }), o, listen)).rejects.toThrow(
      RemoteBindRefused,
    );
    expect(listen).not.toHaveBeenCalled();
    expect(o.prompted).toEqual([]);
  });

  it('never listens without --allow-remote', async () => {
    const o = io('y');
    const listen = vi.fn().mockResolvedValue('handle');
    await expect(bindWithExposureGate(target({ allowRemote: false }), o, listen)).rejects.toThrow(
      RemoteBindRefused,
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it('discloses before prompting, and does not listen until the answer is yes', async () => {
    const o = io('y');
    const listen = vi.fn().mockResolvedValue('handle');
    // Ordering: everything disclosed must already be on screen when the question
    // is asked — a question about an unnamed thing is not a confirmation.
    const withOrder = {
      lines: o.lines,
      log: o.log,
      prompt: (q: string): Promise<string> => {
        expect(o.lines.join('\n')).toContain('/named/.lattice');
        expect(listen).not.toHaveBeenCalled();
        o.prompted.push(q);
        return Promise.resolve('y');
      },
    };
    await expect(bindWithExposureGate(target(), withOrder, listen)).resolves.toBe('handle');
    expect(o.prompted).toHaveLength(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('refuses on a negative answer, and on anything that is not a yes', async () => {
    for (const answer of ['n', 'no', '', 'maybe', 'Y E S']) {
      const o = io(answer);
      const listen = vi.fn().mockResolvedValue('handle');
      await expect(bindWithExposureGate(target(), o, listen)).rejects.toThrow(RemoteBindRefused);
      expect(listen).not.toHaveBeenCalled();
      // It still said what it would have exposed.
      expect(o.lines.join('\n')).toContain('/named/.lattice');
    }
  });

  it('accepts an affirmative answer in either case, with surrounding whitespace', async () => {
    for (const answer of ['y', 'Y', 'yes', ' YES ']) {
      const o = io(answer);
      const listen = vi.fn().mockResolvedValue('handle');
      await expect(bindWithExposureGate(target(), o, listen)).resolves.toBe('handle');
      expect(listen).toHaveBeenCalledTimes(1);
    }
  });

  it('--yes skips the prompt but NOT the disclosure', async () => {
    const o = io('n'); // would refuse if it were consulted
    const listen = vi.fn().mockResolvedValue('handle');
    await expect(bindWithExposureGate(target({ assumeYes: true }), o, listen)).resolves.toBe(
      'handle',
    );
    expect(o.prompted).toEqual([]);
    const text = o.lines.join('\n');
    expect(text).toContain('/named/.lattice');
    expect(text).toContain('Notes');
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than assuming yes when there is nothing to ask (no terminal)', async () => {
    const o = io(); // no prompt available — scripted/piped invocation
    const listen = vi.fn().mockResolvedValue('handle');
    await expect(bindWithExposureGate(target(), o, listen)).rejects.toThrow(/--yes/);
    expect(listen).not.toHaveBeenCalled();
    // Still discloses, so the operator can see what it declined to publish.
    expect(o.lines.join('\n')).toContain('/named/.lattice');
  });
});
