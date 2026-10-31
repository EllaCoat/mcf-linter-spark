use crate::diag::ParseError;

/// Brigadier's StringReader over one command line. Offsets returned by the
/// reader are file offsets: `base` is the offset of `src[0]` in the file.
#[derive(Clone, Copy)]
pub struct Reader<'a> {
    pub src: &'a str,
    pub pos: usize,
    pub base: u32,
}

pub type PResult<T> = Result<T, ParseError>;

pub fn is_allowed_number(b: u8) -> bool {
    b.is_ascii_digit() || b == b'.' || b == b'-'
}

pub fn is_allowed_in_unquoted(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+')
}

pub fn is_quote(b: u8) -> bool {
    b == b'"' || b == b'\''
}

impl<'a> Reader<'a> {
    pub fn new(src: &'a str, base: u32) -> Self {
        Reader { src, pos: 0, base }
    }

    pub fn offset(&self) -> u32 {
        self.base + self.pos as u32
    }

    pub fn offset_of(&self, pos: usize) -> u32 {
        self.base + pos as u32
    }

    pub fn can_read(&self) -> bool {
        self.pos < self.src.len()
    }

    pub fn can_read_n(&self, n: usize) -> bool {
        self.pos + n <= self.src.len()
    }

    pub fn peek(&self) -> Option<u8> {
        self.src.as_bytes().get(self.pos).copied()
    }

    pub fn peek_at(&self, n: usize) -> Option<u8> {
        self.src.as_bytes().get(self.pos + n).copied()
    }

    pub fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    pub fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }

    pub fn skip(&mut self) {
        if let Some(c) = self.peek_char() {
            self.pos += c.len_utf8();
        }
    }

    pub fn error(&self, message: impl Into<String>) -> ParseError {
        let end = self.pos + self.peek_char().map_or(0, |c| c.len_utf8());
        ParseError::new(self.offset(), self.offset_of(end), message)
    }

    pub fn error_span(&self, start: usize, message: impl Into<String>) -> ParseError {
        let end = if self.pos > start { self.pos } else { start + self.src[start..].chars().next().map_or(0, |c| c.len_utf8()) };
        ParseError::new(self.offset_of(start), self.offset_of(end), message)
    }

    pub fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek_char() {
            if c.is_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }

    pub fn expect(&mut self, b: u8) -> PResult<()> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(format!("Expected '{}'", b as char)))
        }
    }

    pub fn try_consume(&mut self, b: u8) -> bool {
        if self.peek() == Some(b) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    pub fn read_while(&mut self, f: impl Fn(u8) -> bool) -> &'a str {
        let start = self.pos;
        let bytes = self.src.as_bytes();
        while self.pos < bytes.len() && f(bytes[self.pos]) {
            self.pos += 1;
        }
        &self.src[start..self.pos]
    }

    pub fn read_unquoted(&mut self) -> &'a str {
        self.read_while(is_allowed_in_unquoted)
    }

    /// Reads up to the next space (or the end of the line).
    pub fn read_word(&mut self) -> &'a str {
        let start = self.pos;
        while let Some(c) = self.peek_char() {
            if c == ' ' {
                break;
            }
            self.pos += c.len_utf8();
        }
        &self.src[start..self.pos]
    }

    pub fn read_quoted(&mut self) -> PResult<String> {
        let start = self.pos;
        let quote = match self.peek() {
            Some(q) if is_quote(q) => q,
            _ => return Err(self.error("Expected quote to start a string")),
        };
        self.pos += 1;
        self.read_until(quote).map_err(|e| ParseError::new(self.offset_of(start), e.end, e.message))
    }

    pub fn read_until(&mut self, terminator: u8) -> PResult<String> {
        let mut out = String::new();
        let mut escaped = false;
        while let Some(c) = self.peek_char() {
            self.pos += c.len_utf8();
            if escaped {
                if c as u32 == terminator as u32 || c == '\\' {
                    out.push(c);
                    escaped = false;
                } else {
                    self.pos -= c.len_utf8();
                    return Err(self.error(format!("Invalid escape sequence '{c}' in quoted string")));
                }
            } else if c == '\\' {
                escaped = true;
            } else if c as u32 == terminator as u32 {
                return Ok(out);
            } else {
                out.push(c);
            }
        }
        Err(ParseError::new(self.offset(), self.offset(), "Unclosed quoted string"))
    }

    /// Returns the string and the quote character used, if any.
    pub fn read_string(&mut self) -> PResult<(String, Option<u8>)> {
        match self.peek() {
            Some(q) if is_quote(q) => Ok((self.read_quoted()?, Some(q))),
            _ => Ok((self.read_unquoted().to_string(), None)),
        }
    }

    fn read_number_text(&mut self, what: &str) -> PResult<(usize, &'a str)> {
        let start = self.pos;
        let text = self.read_while(is_allowed_number);
        if text.is_empty() {
            return Err(self.error(format!("Expected {what}")));
        }
        Ok((start, text))
    }

    pub fn read_int(&mut self) -> PResult<i32> {
        let (start, text) = self.read_number_text("integer")?;
        text.parse::<i32>().map_err(|_| self.error_span(start, format!("Invalid integer '{text}'")))
    }

    pub fn read_long(&mut self) -> PResult<i64> {
        let (start, text) = self.read_number_text("long")?;
        text.parse::<i64>().map_err(|_| self.error_span(start, format!("Invalid long '{text}'")))
    }

    pub fn read_double(&mut self) -> PResult<f64> {
        let (start, text) = self.read_number_text("double")?;
        parse_java_double(text).ok_or_else(|| self.error_span(start, format!("Invalid double '{text}'")))
    }

    pub fn read_float(&mut self) -> PResult<f32> {
        let (start, text) = self.read_number_text("float")?;
        parse_java_double(text)
            .map(|v| v as f32)
            .ok_or_else(|| self.error_span(start, format!("Invalid float '{text}'")))
    }

    pub fn read_bool(&mut self) -> PResult<bool> {
        let start = self.pos;
        let (s, _) = self.read_string()?;
        match s.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            "" => Err(self.error("Expected bool")),
            _ => Err(self.error_span(start, format!("Invalid bool, expected true or false but found '{s}'"))),
        }
    }
}

/// Java's Double.parseDouble accepts forms such as ".5" and "1." that Rust also
/// accepts; "-" alone and repeated signs are rejected by both.
pub fn parse_java_double(text: &str) -> Option<f64> {
    if text == "-" || text == "." || text == "-." {
        return None;
    }
    text.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_quoted_strings_with_escapes() {
        let mut r = Reader::new(r#""a\"b\\c" rest"#, 0);
        assert_eq!(r.read_quoted().unwrap(), r#"a"b\c"#);
        assert_eq!(r.rest(), " rest");
    }

    #[test]
    fn rejects_invalid_escape() {
        let mut r = Reader::new(r#""a\n""#, 0);
        assert!(r.read_quoted().is_err());
    }

    #[test]
    fn reads_numbers_like_brigadier() {
        assert_eq!(Reader::new("-12 ", 0).read_int().unwrap(), -12);
        assert!(Reader::new("1.5", 0).read_int().is_err());
        assert_eq!(Reader::new(".5", 0).read_double().unwrap(), 0.5);
        assert!(Reader::new("abc", 0).read_double().is_err());
    }
}
