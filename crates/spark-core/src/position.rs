/// Converts byte offsets into zero-based lines and UTF-16 columns, as LSP counts them.
pub struct LineIndex {
    starts: Vec<u32>,
    units: Vec<u32>,
}

const CHUNK: usize = 256;

impl LineIndex {
    pub fn new(text: &str) -> LineIndex {
        let mut starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i as u32 + 1);
            }
        }
        let mut units = Vec::with_capacity(text.len() / CHUNK + 1);
        let (mut count, mut from) = (0, 0);
        for chunk in 0..=text.len() / CHUNK {
            let to = text.floor_char_boundary(chunk * CHUNK);
            count += text[from..to].encode_utf16().count() as u32;
            units.push(count);
            from = to;
        }
        LineIndex { starts, units }
    }

    pub fn position(&self, text: &str, offset: u32) -> (u32, u32) {
        let offset = text.floor_char_boundary(offset as usize);
        let line = self.starts.partition_point(|&s| s as usize <= offset) - 1;
        let col = self.units_before(text, offset) - self.units_before(text, self.starts[line] as usize);
        (line as u32, col)
    }

    pub fn utf16_offset(&self, text: &str, offset: u32) -> u32 {
        self.units_before(text, text.floor_char_boundary(offset as usize))
    }

    fn units_before(&self, text: &str, offset: usize) -> u32 {
        let chunk = offset / CHUNK;
        self.units[chunk] + text[text.floor_char_boundary(chunk * CHUNK)..offset].encode_utf16().count() as u32
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

    #[test]
    fn columns_of_a_long_line_count_the_characters_across_chunks() {
        let text = format!("a\n{}", "x🙂あ".repeat(400));
        let idx = LineIndex::new(&text);
        for (offset, _) in text.char_indices().chain([(text.len(), ' ')]) {
            let line = usize::from(offset >= 2);
            let col = text[if line == 1 { 2 } else { 0 }..offset].encode_utf16().count() as u32;
            assert_eq!(idx.position(&text, offset as u32), (line as u32, col), "{offset}");
            assert_eq!(idx.utf16_offset(&text, offset as u32), text[..offset].encode_utf16().count() as u32, "{offset}");
        }
    }
}
