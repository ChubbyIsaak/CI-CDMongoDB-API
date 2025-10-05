declare module "ipaddr.js" {
  export type Kind = "ipv4" | "ipv6";
  export interface IPAddress {
    kind(): Kind;
    toString(): string;
    toNormalizedString(): string;
    match(range: [IPAddress, number]): boolean;
    isIPv4MappedAddress?(): boolean;
    toIPv4Address?(): IPAddress;
  }
  export function parse(s: string): IPAddress;
  export function parseCIDR(s: string): [IPAddress, number];
}
