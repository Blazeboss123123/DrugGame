import { clamp } from './math';

/** Game clock. One real second is one game minute, so a full day lasts 24 real minutes. */
export class TimeOfDay {
  day = 1;
  minutes = 8 * 60 + 40;
  speed = 1;

  /** Sets speed from a day length in real minutes ('real' = one game minute per real minute). */
  setDayLength(len: number | 'real') {
    if (len === 'real') {
      if (this.speed !== 1 / 60) this.syncToClock();
      this.speed = 1 / 60;
    } else this.speed = 1440 / (len * 60);
  }

  /** Real-time mode: jump the in-game clock to the local wall-clock time (same day number). */
  syncToClock() {
    const now = new Date();
    this.minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  }

  update(dt: number): void {
    this.minutes += dt * this.speed;
    while (this.minutes >= 1440) {
      this.minutes -= 1440;
      this.day++;
    }
  }

  get label(): string {
    const h = Math.floor(this.minutes / 60);
    const m = Math.floor(this.minutes % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  get weekday(): string {
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(this.day - 1) % 7];
  }

  /** Advance to the given hour, rolling into the next day if it has already passed. */
  skipTo(hour: number): void {
    if (this.minutes >= hour * 60) this.day++;
    this.minutes = hour * 60;
  }

  /** Sun elevation (radians) and azimuth (radians from north, clockwise). Sunrise 06:00, sunset 21:00. */
  sun(): { elevation: number; azimuth: number } {
    const rise = 360;
    const set = 1260;
    const t = this.minutes;
    if (t >= rise && t <= set) {
      const f = (t - rise) / (set - rise);
      return { elevation: Math.sin(Math.PI * f) * (62 * Math.PI) / 180, azimuth: ((80 + 200 * f) * Math.PI) / 180 };
    }
    const nightLen = 1440 - (set - rise);
    const nt = t > set ? t - set : t + 1440 - set;
    const f = clamp(nt / nightLen, 0, 1);
    return { elevation: -Math.sin(Math.PI * f) * (35 * Math.PI) / 180, azimuth: ((280 + 160 * f) * Math.PI) / 180 };
  }
}
