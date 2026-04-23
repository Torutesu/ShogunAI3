//! Platform biometric gate (macOS LocalAuthentication). Other targets: unsupported stubs.

use serde_json::{json, Value};

pub fn status_json() -> Value {
  #[cfg(target_os = "macos")]
  {
    macos::status_json()
  }
  #[cfg(not(target_os = "macos"))]
  {
    json!({
      "supported": false,
      "enrolled": false,
      "platform": "unsupported",
      "biometryType": "none",
    })
  }
}

/// Returns Ok(()) on success, Err(message) on failure or user cancel.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn authenticate(reason: &str) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    macos::authenticate(reason)
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Biometric authentication is not available on this platform.".to_string())
  }
}

#[cfg(target_os = "macos")]
mod macos {
  use super::*;
  use block2::RcBlock;
  use objc2_foundation::{NSError, NSString};
  use objc2_local_authentication::{LAContext, LABiometryType, LAPolicy};

  pub fn status_json() -> Value {
    let ctx = unsafe { LAContext::new() };

    let policy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
    let can = unsafe { ctx.canEvaluatePolicy_error(policy) };
    let (enrolled, err_msg) = match can {
      Ok(()) => (true, None),
      Err(e) => (false, Some(ns_error_summary(&*e))),
    };

    let bio = unsafe { ctx.biometryType() };
    let biometry_type = match bio {
      LABiometryType::TouchID => "touchId",
      LABiometryType::FaceID => "faceId",
      LABiometryType::OpticID => "opticId",
      _ => "none",
    };

    json!({
      "supported": true,
      "platform": "macos",
      "enrolled": enrolled,
      "biometryType": biometry_type,
      "error": err_msg,
    })
  }

  fn ns_error_summary(err: &NSError) -> String {
    err.localizedDescription().to_string()
  }

  pub fn authenticate(reason: &str) -> Result<(), String> {
    let reason = reason.trim();
    if reason.is_empty() {
      return Err("localizedReason is required".to_string());
    }

    let ctx = unsafe { LAContext::new() };

    let policy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
    unsafe {
      if let Err(e) = ctx.canEvaluatePolicy_error(policy) {
        return Err(ns_error_summary(&*e));
      }
    }

       let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let reason_ns = NSString::from_str(reason);

    let block = RcBlock::new(move |success: objc2::runtime::Bool, error: *mut NSError| {
      let out = if success.as_bool() {
        Ok(())
      } else if error.is_null() {
        Err("Biometric authentication failed.".to_string())
      } else {
        // SAFETY: framework supplies a valid NSError when success is false.
        let err = unsafe { error.as_ref() }.expect("NSError pointer should be valid");
        Err(ns_error_summary(err))
      };
      let _ = tx.send(out);
    });

    unsafe {
      ctx.evaluatePolicy_localizedReason_reply(policy, &reason_ns, &block);
    }

    let out = rx
      .recv()
      .map_err(|_| "Biometric authentication channel closed".to_string())?;
    drop(ctx);
    out
  }
}
