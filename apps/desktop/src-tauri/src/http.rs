//! The tray's HTTP to the local console: plain GETs on 127.0.0.1, one connection each. The console is
//! local and speaks HTTP/1.1 without TLS, so a client this small does: a status line, the headers, and
//! a body that is chunked (the event stream), sized, or read to the end. A read that waits longer than
//! its timeout fails, which is what tells a silent event stream from a live one.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// A JSON answer larger than this is not the console's.
const MAX_TEXT: u64 = 4 << 20;

/// What the head of a response says about its body.
#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub chunked: bool,
    pub length: Option<u64>,
}

/// Opens `GET path` on the console and reads the head. Every read on the connection, the body's
/// included, fails after `read_timeout` without data.
pub fn open(
    port: u16,
    path: &str,
    read_timeout: Duration,
) -> io::Result<(Head, Box<dyn BufRead + Send>)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(CONNECT_TIMEOUT))?;
    // Host names a local address: the console refuses any other (its DNS-rebinding guard).
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    )?;
    let mut reader = BufReader::new(stream);
    let head = read_head(&mut reader)?;
    let body = body(framing(&head), reader);
    Ok((head, body))
}

/// `GET path` as text, when the console answers 200.
pub fn get_text(port: u16, path: &str, timeout: Duration) -> io::Result<String> {
    let (head, body) = open(port, path, timeout)?;
    if head.status != 200 {
        return Err(io::Error::other(format!("{path}: HTTP {}", head.status)));
    }
    let mut text = String::new();
    body.take(MAX_TEXT).read_to_string(&mut text)?;
    Ok(text)
}

enum Framing {
    Chunked,
    Sized(u64),
    UntilClose,
}

fn framing(head: &Head) -> Framing {
    match (head.chunked, head.length) {
        (true, _) => Framing::Chunked,
        (false, Some(n)) => Framing::Sized(n),
        (false, None) => Framing::UntilClose,
    }
}

fn body<R: BufRead + Send + 'static>(framing: Framing, reader: R) -> Box<dyn BufRead + Send> {
    match framing {
        Framing::Chunked => Box::new(BufReader::new(Chunked::new(reader))),
        Framing::Sized(n) => Box::new(reader.take(n)),
        Framing::UntilClose => Box::new(reader),
    }
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

/// The status line and the headers, up to the blank line that ends them.
pub fn read_head<R: BufRead>(r: &mut R) -> io::Result<Head> {
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    let mut parts = line.split_whitespace();
    let status = match (parts.next(), parts.next()) {
        (Some(v), Some(code)) if v.starts_with("HTTP/1.") => {
            code.parse().map_err(|_| invalid("bad status"))?
        }
        _ => return Err(invalid("not an HTTP response")),
    };
    let mut head = Head {
        status,
        chunked: false,
        length: None,
    };
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let l = line.trim_end();
        if l.is_empty() {
            return Ok(head);
        }
        let Some((name, value)) = l.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("transfer-encoding") {
            head.chunked = value.to_ascii_lowercase().contains("chunked");
        } else if name.eq_ignore_ascii_case("content-length") {
            head.length = Some(value.parse().map_err(|_| invalid("bad length"))?);
        }
    }
}

/// A chunked body, decoded: the data of each chunk, and the end at the zero-sized one.
pub struct Chunked<R> {
    inner: R,
    left: usize,
    done: bool,
}

impl<R: BufRead> Chunked<R> {
    pub fn new(inner: R) -> Self {
        Chunked {
            inner,
            left: 0,
            done: false,
        }
    }
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut line = String::new();
            if self.inner.read_line(&mut line)? == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let size = line.trim().split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size, 16).map_err(|_| invalid("bad chunk size"))?;
            if size == 0 {
                self.done = true;
                return Ok(0);
            }
            self.left = size;
        }
        let want = buf.len().min(self.left);
        let n = self.inner.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.left -= n;
        if self.left == 0 {
            // the CRLF after the chunk's data
            let mut crlf = String::new();
            self.inner.read_line(&mut crlf)?;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn head_of_a_sized_answer() {
        let mut r = Cursor::new(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        );
        let head = read_head(&mut r).unwrap();
        assert_eq!(
            head,
            Head {
                status: 200,
                chunked: false,
                length: Some(2)
            }
        );
        let mut rest = String::new();
        body(framing(&head), r).read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "{}");
    }

    #[test]
    fn head_of_a_stream() {
        let mut r = Cursor::new("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n");
        assert!(read_head(&mut r).unwrap().chunked);
    }

    #[test]
    fn not_http_is_an_error() {
        assert!(read_head(&mut Cursor::new("SSH-2.0-OpenSSH\r\n\r\n")).is_err());
        assert!(read_head(&mut Cursor::new("HTTP/1.1 200 OK\r\n")).is_err());
    }

    #[test]
    fn chunked_body_decoded_across_chunks() {
        let wire = "7\r\nevent: \r\n6;x=y\r\nstate\n\r\n0\r\n\r\n";
        let mut lines = BufReader::new(Chunked::new(Cursor::new(wire))).lines();
        assert_eq!(lines.next().unwrap().unwrap(), "event: state");
        assert!(lines.next().is_none());
    }

    #[test]
    fn a_cut_chunk_is_an_error() {
        let mut out = Vec::new();
        let err = Chunked::new(Cursor::new("a\r\nshort"))
            .read_to_end(&mut out)
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }
}
