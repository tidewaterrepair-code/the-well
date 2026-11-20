// All sound is made in the browser: a low drone, chains while the sphere turns,
// a heavy thud when a chamber opens. No audio files to load. Off until asked for.
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private chainGain: GainNode | null = null;
  on = false;

  private noise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  toggle(): boolean {
    try {
      if (!this.ctx) this.build();
      this.on = !this.on;
      void this.ctx!.resume();
      this.master!.gain.setTargetAtTime(this.on ? 0.5 : 0, this.ctx!.currentTime, 0.4);
    } catch {
      this.on = false; // audio is blocked here; stay silent
    }
    return this.on;
  }

  private build() {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = (this.ctx = new Ctx());
    const master = (this.master = ctx.createGain());
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Drone: two low, slightly detuned tones and a slow breath of filtered air.
    for (const [freq, gain] of [[41, 0.5], [41.6, 0.4], [82.5, 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 160;
      const g = ctx.createGain();
      g.gain.value = gain * 0.5;
      o.connect(f).connect(g).connect(master);
      o.start();
    }
    const air = ctx.createBufferSource();
    air.buffer = this.noise(4);
    air.loop = true;
    const af = ctx.createBiquadFilter();
    af.type = 'bandpass';
    af.frequency.value = 320;
    af.Q.value = 0.6;
    const ag = ctx.createGain();
    ag.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 0.035;
    lfo.connect(lg).connect(ag.gain);
    air.connect(af).connect(ag).connect(master);
    air.start();
    lfo.start();

    // Chains: metallic noise whose loudness follows how fast the sphere is turning.
    const chain = ctx.createBufferSource();
    chain.buffer = this.noise(2);
    chain.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 2600;
    cf.Q.value = 5;
    const rattle = ctx.createOscillator();
    rattle.type = 'square';
    rattle.frequency.value = 19;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    const cg = (this.chainGain = ctx.createGain());
    cg.gain.value = 0;
    rattle.connect(rg.gain);
    chain.connect(cf).connect(rg).connect(cg).connect(master);
    chain.start();
    rattle.start();
  }

  /** speed: frames per second the sphere is turning at. */
  turning(speed: number) {
    if (!this.on || !this.chainGain) return;
    this.chainGain.gain.setTargetAtTime(Math.min(0.5, Math.abs(speed) * 0.02), this.ctx!.currentTime, 0.08);
  }

  thud() {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 1);
    const n = ctx.createBufferSource();
    n.buffer = this.noise(0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    n.connect(f).connect(ng).connect(this.master!);
    n.start(t);
  }
}
