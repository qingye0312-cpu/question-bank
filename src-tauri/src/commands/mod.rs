//! Thin IPC adapters; mutations remain serialized through the shared writer.
use crate::*;
pub(crate) mod cloud;
pub(crate) mod exchange;
pub(crate) mod intake;
pub(crate) mod library;
pub(crate) mod ocr;
