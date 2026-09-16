import type * as MoonBit from "./moonbit.d.ts";

export function double_x(p: any,
                         factor: MoonBit.Int): MoonBit.Int;

export function set_cb(p: any,
                       cb: any): MoonBit.String;

export function shutdown(p: any): any;

export function scale_point(p: any,
                            inner: any): any;

export function Point(x: MoonBit.Int,
                      y: MoonBit.Int): any;

export function Runtime(point: any): any;
