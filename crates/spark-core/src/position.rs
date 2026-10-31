/// Converts byte offsets into zero-based lines and UTF-16 columns, as LSP counts them.
pub struct LineIndex {
    starts: Vec<u32>,
}

impl LineIndex {
    pub fn new(text: &str) -> LineIndex {
        let mut starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i as u32 + 1);
            }
        }
        LineIndex { starts }
    }

    pub fn position(&self, text: &str, offset: u32) -> (u32, u32) {
        let offset = text.floor_char_boundary(offset as usize) as u32;
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let start = self.starts[line] as usize;
        let col = text[start..offset as usize].encode_utf16().count() as u32;
        (line as u32, col)
    }

    /// The byte offset of a zero-based line and UTF-16 column.
    pub fn offset(&self, text: &str, line: u32, col: u32) -> u32 {
        let Some(&start) = self.starts.get(line as usize) else { return text.len() as u32 };
        let mut units = 0;
        for (i, c) in text[start as usize..].char_indices() {
            if units >= col || c == '\n' {
                return start + i as u32;
            }
            units += c.len_utf16() as u32;
        }
        text.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_utf16_columns() {
        let text = "ab\nあいz\n";
        let idx = LineIndex::new(text);
        let z = text.find('z').unwrap() as u32;
        assert_eq!(idx.position(text, z), (1, 2));
        assert_eq!(idx.offset(text, 1, 2), z);
    }

    #[test]
    fn an_offset_inside_a_character_does_not_panic() {
        let text = "ab\nあいz\n";
        let idx = LineIndex::new(text);
        assert_eq!(idx.position(text, 4), (1, 0));
        assert_eq!(idx.position(text, 100), (2, 0));
    }
}
