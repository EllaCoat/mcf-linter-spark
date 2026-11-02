export type Severity = "Error" | "Warning" | "Information" | "Hint";

/** The order of `Severity` (`Error` is the smallest), for comparisons and sorting. */
export const SEVERITY_RANK: Record<Severity, number> = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export function severityAsStr(s: Severity): string {
  switch (s) {
    case "Error":
      return "error";
    case "Warning":
      return "warning";
    case "Information":
      return "information";
    case "Hint":
      return "hint";
  }
}

export function severityParse(s: string): Severity | undefined {
  switch (s) {
    case "error":
      return "Error";
    case "warning":
      return "Warning";
    case "information":
    case "info":
      return "Information";
    case "hint":
      return "Hint";
    default:
      return undefined;
  }
}

/** Offsets are UTF-16 code units from the start of the file. */
export interface Diagnostic {
  start: number;
  end: number;
  severity: Severity;
  code: string;
  message: string;
}

/** A problem that stops parsing of the current command. */
export class ParseError {
  readonly start: number;
  readonly end: number;
  readonly message: string;
  readonly severity: Severity;

  constructor(start: number, end: number, message: string, severity: Severity = "Error") {
    this.start = start;
    this.end = Math.max(end, start);
    this.message = message;
    this.severity = severity;
  }

  warning(): ParseError {
    return new ParseError(this.start, this.end, this.message, "Warning");
  }
}

export function parseErrorEquals(a: ParseError, b: ParseError): boolean {
  return a.start === b.start && a.end === b.end && a.message === b.message && a.severity === b.severity;
}

/** A failure that stops the whole run: settings that cannot be read, vanilla data that cannot be loaded. */
export class SparkError extends Error {}
