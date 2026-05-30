// Phase 2.7 parity fixture. Covers the four callable forms the TS
// resolver must handle: class methods, arrow-function class properties,
// top-level function declarations, top-level const-assigned arrow
// functions. Driver.drive exercises invocations against all four.

export class Calculator {
  run(a: number, b: number): number {
    const sum = this.add(a, b);
    const doubled = Helper.double(sum);
    const wrapper = new Wrapper(doubled);
    return wrapper.value;
  }

  private add(a: number, b: number): number {
    return a + b;
  }

  // Arrow function attached as a class property.
  reset = (): void => {
    Helper.double(0);
  };
}

export class Helper {
  static double(x: number): number {
    return x * 2;
  }
}

export class Wrapper {
  constructor(public readonly value: number) {}
}

export function topLevelHelper(): number {
  return Helper.double(1);
}

export const topLevelArrow = (): number => {
  return topLevelHelper();
};

export class Driver {
  drive(): void {
    const c = new Calculator();
    c.run(1, 2);
    c.reset();
    topLevelHelper();
    topLevelArrow();
  }
}
