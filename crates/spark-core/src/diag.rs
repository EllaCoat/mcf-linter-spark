#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Information => "information",
            Severity::Hint => "hint",
        }
    }

    pub fn parse(s: &str) -> Option<Severity> {
        match s {
            "error" => Some(Severity::Error),
            "warning" => Some(Severity::Warning),
            "information" | "info" => Some(Severity::Information),
            "hint" => Some(Severity::Hint),
            _ => None,
        }
    }
}

/// Byte offsets are relative to the start of the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub start: u32,
    pub end: u32,
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
}

/// A syntax error that stops parsing of the current command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub start: u32,
    pub end: u32,
    pub message: String,
}

impl ParseError {
    pub fn new(start: u32, end: u32, message: impl Into<String>) -> Self {
        ParseError { start, end: end.max(start), message: message.into() }
    }
}
