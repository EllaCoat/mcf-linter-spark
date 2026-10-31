//! Coordinates: `WorldCoordinates`, `LocalCoordinates`, and their 2D forms.

use crate::reader::{PResult, Reader};

#[derive(Clone, Copy, PartialEq)]
enum Num {
    Int,
    Double,
}

/// One world coordinate: `~`, `~1.5`, `5`, `-2.5`.
fn world_coordinate(r: &mut Reader, num: Num) -> PResult<()> {
    if r.peek() == Some(b'^') {
        return Err(r.error("Cannot mix world & local coordinates (everything must either use ^ or not)"));
    }
    if !r.can_read() {
        return Err(r.error("Expected a coordinate"));
    }
    let relative = r.try_consume(b'~');
    if relative {
        if r.can_read() && r.peek() != Some(b' ') {
            r.read_double()?;
        }
    } else {
        match num {
            Num::Int => {
                r.read_int()?;
            }
            Num::Double => {
                r.read_double()?;
            }
        }
    }
    Ok(())
}

fn local_coordinate(r: &mut Reader) -> PResult<()> {
    if !r.try_consume(b'^') {
        return Err(r.error("Cannot mix world & local coordinates (everything must either use ^ or not)"));
    }
    if r.can_read() && r.peek() != Some(b' ') {
        r.read_double()?;
    }
    Ok(())
}

fn separator(r: &mut Reader, expected: &str) -> PResult<()> {
    if r.peek() == Some(b' ') {
        r.pos += 1;
        Ok(())
    } else {
        Err(r.error(format!("Incomplete (expected {expected})")))
    }
}

fn coordinates(r: &mut Reader, count: usize, num: Num, allow_local: bool) -> PResult<()> {
    let expected = if count == 3 { "3 coordinates" } else { "2 coordinates" };
    if allow_local && r.peek() == Some(b'^') {
        for i in 0..count {
            if i > 0 {
                separator(r, expected)?;
            }
            local_coordinate(r)?;
        }
        return Ok(());
    }
    for i in 0..count {
        if i > 0 {
            separator(r, expected)?;
        }
        world_coordinate(r, num)?;
    }
    Ok(())
}

pub fn block_pos(r: &mut Reader) -> PResult<()> {
    coordinates(r, 3, Num::Int, true)
}

pub fn vec3(r: &mut Reader) -> PResult<()> {
    coordinates(r, 3, Num::Double, true)
}

pub fn column_pos(r: &mut Reader) -> PResult<()> {
    coordinates(r, 2, Num::Int, false)
}

pub fn vec2(r: &mut Reader) -> PResult<()> {
    coordinates(r, 2, Num::Double, false)
}

pub fn rotation(r: &mut Reader) -> PResult<()> {
    coordinates(r, 2, Num::Double, false)
}

pub fn angle(r: &mut Reader) -> PResult<()> {
    if !r.can_read() {
        return Err(r.error("Incomplete (expected 1 angle)"));
    }
    r.try_consume(b'~');
    if r.can_read() && r.peek() != Some(b' ') {
        r.read_float()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(f: fn(&mut Reader) -> PResult<()>, s: &str) -> bool {
        let mut r = Reader::new(s, 0);
        f(&mut r).is_ok() && !r.can_read()
    }

    #[test]
    fn parses_coordinates() {
        assert!(ok(block_pos, "~ ~1 ~-2"));
        assert!(ok(block_pos, "1 2 3"));
        assert!(!ok(block_pos, "1.5 2 3"));
        assert!(ok(block_pos, "~1.5 ~ ~"));
        assert!(ok(vec3, "^ ^ ^1"));
        assert!(!ok(vec3, "^ ~ ^"));
        assert!(!ok(vec3, "1 2"));
        assert!(ok(vec2, "~ 90"));
        assert!(!ok(rotation, "^ ^"));
    }
}
