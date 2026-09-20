// 时钟抽象：生产用系统时钟，测试/重放用可拨动虚拟时钟。
export class SystemClock {
  now() {
    return Date.now();
  }
}

export class VirtualClock {
  constructor(at) {
    this.t = typeof at === "number" ? at : Date.parse(at);
  }

  now() {
    return this.t;
  }

  set(at) {
    this.t = typeof at === "number" ? at : Date.parse(at);
    return this.t;
  }

  advance(minutes) {
    this.t += minutes * 60_000;
    return this.t;
  }
}
