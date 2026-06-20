//! macOS Accessibility (AXUIElement) snapshot of the focused control — text only, no screenshots.
//!
//! Types and helpers here serve the macOS-only `imp` submodule and the
//! pure-formatter unit tests. On non-macOS builds every item is reachable
//! only from `#[cfg(test)]`, so the top-level definitions look dead —
//! silence that per-platform so Mac CI still flags truly dead code.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Pixel-coordinate frame of the focused window. Read via AXPosition + AXSize.
/// Coordinates are in macOS global display space (multi-monitor aware).
#[derive(Debug, Clone)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Raw strings copied from the focused AX element. All fields are owned so
/// the formatter stays pure and testable on any platform.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct AxFields {
    pub role: String,
    pub subrole: String,
    pub role_desc: String,
    pub title: String,
    pub label: String,
    pub value: String,
    pub placeholder: String,
    pub document: String,
    pub url: String,
    pub identifier: String,
    pub dom_identifier: String,
    pub filename: String,
    pub help: String,
    pub description: String,
    pub selected_text: String,
    pub range_text: String,
    pub window: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxDiagnostics {
    pub trusted: Option<bool>,
    pub focused_element_present: bool,
    pub focused_role: Option<String>,
    pub focused_window_title: Option<String>,
    pub snapshot_present: bool,
    pub tree_present: bool,
    pub reason: &'static str,
}

/// Hard cap on any single user-content field so a giant textarea cannot bloat
/// the memory snippet.
const AX_VALUE_CHAR_CAP: usize = 500;

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn ax_text_has_content_signal(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        [
            "title=",
            "label=",
            "value=",
            "placeholder=",
            "description=",
            "selected=",
            "text=",
            "url=",
            "document=",
            "filename=",
            "help=",
        ]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix) || trimmed.contains(&format!(" {prefix}")))
    })
}

/// Format an [`AxFields`] into the newline-joined snapshot string the sampler
/// ingests. Returns `None` when the focused element is a secure text field
/// (password input) or when every field is empty. Secure inputs are dropped
/// before any ingest so passwords never reach the memory store.
pub fn format_snapshot(fields: &AxFields) -> Option<String> {
    if fields.role == "AXSecureTextField" {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if !fields.role.is_empty() {
        parts.push(format!("role={}", fields.role));
    }
    if !fields.subrole.is_empty() {
        parts.push(format!("subrole={}", fields.subrole));
    }
    if !fields.role_desc.is_empty() {
        parts.push(format!("roleDesc={}", fields.role_desc));
    }
    if !fields.title.is_empty() {
        parts.push(format!("title={}", fields.title));
    }
    if !fields.label.is_empty() {
        parts.push(format!("label={}", clip(&fields.label, AX_VALUE_CHAR_CAP)));
    }
    if !fields.value.is_empty() {
        parts.push(format!("value={}", clip(&fields.value, AX_VALUE_CHAR_CAP)));
    }
    if !fields.placeholder.is_empty() {
        parts.push(format!(
            "placeholder={}",
            clip(&fields.placeholder, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.document.is_empty() {
        parts.push(format!(
            "document={}",
            clip(&fields.document, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.url.is_empty() {
        parts.push(format!("url={}", clip(&fields.url, AX_VALUE_CHAR_CAP)));
    }
    if !fields.identifier.is_empty() {
        parts.push(format!(
            "identifier={}",
            clip(&fields.identifier, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.dom_identifier.is_empty() {
        parts.push(format!(
            "domIdentifier={}",
            clip(&fields.dom_identifier, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.filename.is_empty() {
        parts.push(format!(
            "filename={}",
            clip(&fields.filename, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.help.is_empty() {
        parts.push(format!("help={}", clip(&fields.help, AX_VALUE_CHAR_CAP)));
    }
    if !fields.description.is_empty() {
        parts.push(format!(
            "description={}",
            clip(&fields.description, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.selected_text.is_empty() {
        parts.push(format!(
            "selected={}",
            clip(&fields.selected_text, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.range_text.is_empty() {
        parts.push(format!(
            "text={}",
            clip(&fields.range_text, AX_VALUE_CHAR_CAP)
        ));
    }
    if !fields.window.is_empty() {
        parts.push(format!("window={}", fields.window));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn ax_diagnostics_reason(
    trusted: Option<bool>,
    focused_element_present: bool,
    focused_role: Option<&str>,
    snapshot_present: bool,
    tree_present: bool,
) -> &'static str {
    if trusted == Some(false) {
        return "accessibility_untrusted";
    }
    if !focused_element_present {
        return "focused_element_unavailable";
    }
    if focused_role == Some("AXSecureTextField") {
        return "secure_text_field";
    }
    if snapshot_present {
        return "focused_element_snapshot";
    }
    if tree_present {
        return "focused_tree_fallback";
    }
    "focused_element_fields_empty"
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{ax_diagnostics_reason, format_snapshot, AxDiagnostics, AxFields};
    use core_foundation::attributed_string::{
        CFAttributedString, CFAttributedStringGetString, CFAttributedStringGetTypeID,
    };
    use core_foundation::base::{CFRange, CFRelease, CFTypeRef, TCFType};
    use core_foundation::number::{CFNumber, CFNumberGetTypeID};
    use core_foundation::string::CFString;
    use core_foundation::url::{CFURLGetTypeID, CFURL};
    use std::collections::HashSet;

    type AXUIElementRef = *const std::ffi::c_void;
    type AXError = i32;
    const AX_ERROR_SUCCESS: AXError = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: core_foundation::string::CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementCopyParameterizedAttributeValue(
            element: AXUIElementRef,
            parameterizedAttribute: core_foundation::string::CFStringRef,
            parameter: CFTypeRef,
            result: *mut CFTypeRef,
        ) -> AXError;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
        /// Returns whether this process is trusted for accessibility (System Settings).
        fn AXIsProcessTrusted() -> u8;
        /// AXValue is an opaque container for CGPoint / CGSize / etc.
        fn AXValueGetValue(value: CFTypeRef, type_: i32, valuePtr: *mut std::ffi::c_void) -> u8;
        fn AXValueCreate(type_: i32, valuePtr: *const std::ffi::c_void) -> CFTypeRef;
        fn AXValueGetTypeID() -> usize;
    }

    const K_AX_VALUE_CG_POINT_TYPE: i32 = 1;
    const K_AX_VALUE_CG_SIZE_TYPE: i32 = 2;
    const K_AX_VALUE_CF_RANGE_TYPE: i32 = 4;
    const AX_RANGE_TEXT_CHAR_CAP: isize = 2_000;
    const AX_TEXT_MARKER_RANGE_ATTRS: &[&str] =
        &["AXVisibleTextMarkerRange", "AXSelectedTextMarkerRange"];
    const AX_TEXT_MARKER_STRING_ATTRS: &[&str] = &[
        "AXStringForTextMarkerRange",
        "AXAttributedStringForTextMarkerRange",
    ];
    const AX_TREE_CHILD_ARRAY_ATTRS: &[&str] = &[
        "AXChildren",
        "AXChildrenInNavigationOrder",
        "AXVisibleChildren",
        "AXRows",
        "AXVisibleRows",
        "AXColumns",
        "AXVisibleColumns",
        "AXCells",
        "AXVisibleCells",
        "AXSelectedCells",
        "AXSelectedColumns",
        "AXContents",
        "AXTabs",
        "AXSelectedTabs",
        "AXSelectedChildren",
        "AXSelectedRows",
        "AXDisclosedRows",
        "AXRowHeaderUIElements",
        "AXColumnHeaderUIElements",
        "AXLinkedUIElements",
        "AXServesAsTitleForUIElements",
        "AXMenuBar",
        "AXExtrasMenuBar",
        "AXWindows",
        "AXVisibleItems",
    ];
    const AX_TREE_CHILD_ELEMENT_ATTRS: &[&str] = &[
        "AXTitleUIElement",
        "AXProxy",
        "AXFocusedUIElement",
        "AXFocusedWindow",
        "AXMainWindow",
        "AXDefaultButton",
        "AXCancelButton",
        "AXHeader",
    ];

    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    unsafe fn copy_attr(element: AXUIElementRef, key: &str) -> Option<CFTypeRef> {
        if element.is_null() {
            return None;
        }
        let attr = CFString::new(key);
        let mut out: CFTypeRef = std::ptr::null();
        if AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out)
            != AX_ERROR_SUCCESS
            || out.is_null()
        {
            return None;
        }
        Some(out)
    }

    unsafe fn string_from_cf_text(cf: CFTypeRef) -> Option<String> {
        if cf.is_null() {
            return None;
        }
        let type_id = CFGetTypeID(cf);
        if type_id == CFStringGetTypeID() {
            let s = CFString::wrap_under_create_rule(cf as *const _);
            return Some(s.to_string());
        }
        if type_id == CFAttributedStringGetTypeID() {
            let attributed = CFAttributedString::wrap_under_create_rule(cf as *const _);
            let raw = CFAttributedStringGetString(attributed.as_concrete_TypeRef());
            if raw.is_null() {
                return None;
            }
            let s = CFString::wrap_under_get_rule(raw);
            return Some(s.to_string());
        }
        if type_id == CFURLGetTypeID() {
            let url = CFURL::wrap_under_create_rule(cf as *const _);
            return Some(url.get_string().to_string());
        }
        CFRelease(cf);
        None
    }

    fn read_string_attr(element: AXUIElementRef, key: &str) -> Option<String> {
        unsafe {
            let cf = copy_attr(element, key)?;
            string_from_cf_text(cf)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }
    }

    fn read_number_attr(element: AXUIElementRef, key: &str) -> Option<i64> {
        unsafe {
            let cf = copy_attr(element, key)?;
            if CFGetTypeID(cf) != CFNumberGetTypeID() {
                CFRelease(cf);
                return None;
            }
            let n = CFNumber::wrap_under_create_rule(cf as *const _);
            n.to_i64()
        }
    }

    unsafe fn read_range_attr(element: AXUIElementRef, key: &str) -> Option<CFRange> {
        let cf = copy_attr(element, key)?;
        if CFGetTypeID(cf) != AXValueGetTypeID() {
            CFRelease(cf);
            return None;
        }
        let mut range = CFRange {
            location: 0,
            length: 0,
        };
        let ok = AXValueGetValue(cf, K_AX_VALUE_CF_RANGE_TYPE, &mut range as *mut _ as *mut _);
        CFRelease(cf);
        if ok != 0 && range.location >= 0 && range.length > 0 {
            Some(range)
        } else {
            None
        }
    }

    unsafe fn copy_parameterized_attr(
        element: AXUIElementRef,
        key: &str,
        parameter: CFTypeRef,
    ) -> Option<CFTypeRef> {
        if element.is_null() || parameter.is_null() {
            return None;
        }
        let attr = CFString::new(key);
        let mut out: CFTypeRef = std::ptr::null();
        if AXUIElementCopyParameterizedAttributeValue(
            element,
            attr.as_concrete_TypeRef(),
            parameter,
            &mut out,
        ) != AX_ERROR_SUCCESS
            || out.is_null()
        {
            return None;
        }
        Some(out)
    }

    unsafe fn read_parameterized_string(
        element: AXUIElementRef,
        key: &str,
        parameter: CFTypeRef,
    ) -> Option<String> {
        copy_parameterized_attr(element, key, parameter)
            .and_then(|cf| string_from_cf_text(cf))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    unsafe fn read_string_for_range(element: AXUIElementRef, range: CFRange) -> Option<String> {
        if range.location < 0 || range.length <= 0 {
            return None;
        }
        let clipped = CFRange {
            location: range.location,
            length: range.length.min(AX_RANGE_TEXT_CHAR_CAP),
        };
        let parameter = AXValueCreate(
            K_AX_VALUE_CF_RANGE_TYPE,
            &clipped as *const _ as *const std::ffi::c_void,
        );
        if parameter.is_null() {
            return None;
        }
        let out = read_parameterized_string(element, "AXStringForRange", parameter).or_else(|| {
            read_parameterized_string(element, "AXAttributedStringForRange", parameter)
        });
        CFRelease(parameter);
        out
    }

    unsafe fn read_string_for_text_marker_range(
        element: AXUIElementRef,
        marker_range: CFTypeRef,
    ) -> Option<String> {
        AX_TEXT_MARKER_STRING_ATTRS
            .iter()
            .find_map(|attr| read_parameterized_string(element, attr, marker_range))
    }

    fn read_text_marker_range_text(element: AXUIElementRef) -> Option<String> {
        unsafe {
            for attr in AX_TEXT_MARKER_RANGE_ATTRS {
                let Some(marker_range) = copy_attr(element, attr) else {
                    continue;
                };
                let out = read_string_for_text_marker_range(element, marker_range);
                CFRelease(marker_range);
                if let Some(text) = out {
                    return Some(text);
                }
            }
            None
        }
    }

    fn read_range_text(element: AXUIElementRef) -> Option<String> {
        unsafe {
            if let Some(text) = read_text_marker_range_text(element) {
                return Some(text);
            }
            for attr in ["AXVisibleCharacterRange", "AXSelectedTextRange"] {
                if let Some(text) =
                    read_range_attr(element, attr).and_then(|r| read_string_for_range(element, r))
                {
                    return Some(text);
                }
            }
            let chars = read_number_attr(element, "AXNumberOfCharacters")?;
            if chars <= 0 {
                return None;
            }
            read_string_for_range(
                element,
                CFRange {
                    location: 0,
                    length: (chars as isize).min(AX_RANGE_TEXT_CHAR_CAP),
                },
            )
        }
    }

    unsafe fn read_point(element: AXUIElementRef, key: &str) -> Option<(f64, f64)> {
        let cf = copy_attr(element, key)?;
        if CFGetTypeID(cf) != AXValueGetTypeID() {
            CFRelease(cf);
            return None;
        }
        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        let ok = AXValueGetValue(cf, K_AX_VALUE_CG_POINT_TYPE, &mut pt as *mut _ as *mut _);
        CFRelease(cf);
        if ok != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }

    unsafe fn read_size(element: AXUIElementRef, key: &str) -> Option<(f64, f64)> {
        let cf = copy_attr(element, key)?;
        if CFGetTypeID(cf) != AXValueGetTypeID() {
            CFRelease(cf);
            return None;
        }
        #[repr(C)]
        struct CGSize {
            w: f64,
            h: f64,
        }
        let mut sz = CGSize { w: 0.0, h: 0.0 };
        let ok = AXValueGetValue(cf, K_AX_VALUE_CG_SIZE_TYPE, &mut sz as *mut _ as *mut _);
        CFRelease(cf);
        if ok != 0 {
            Some((sz.w, sz.h))
        } else {
            None
        }
    }

    fn read_window_title(focused: AXUIElementRef) -> Option<String> {
        unsafe {
            let win = copy_attr(focused, "AXWindow")?;
            let title = read_string_attr(win as AXUIElementRef, "AXTitle");
            CFRelease(win);
            title
        }
    }

    pub fn focused_window_title() -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let focused_app = match copy_attr(system, "AXFocusedApplication") {
                Some(v) => v,
                None => {
                    CFRelease(system as CFTypeRef);
                    return None;
                }
            };
            let out = match copy_attr(focused_app as AXUIElementRef, "AXFocusedWindow") {
                Some(win) => {
                    let title = read_string_attr(win as AXUIElementRef, "AXTitle")
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    CFRelease(win);
                    title
                }
                None => None,
            };
            CFRelease(focused_app);
            CFRelease(system as CFTypeRef);
            out
        }
    }

    fn read_focused_fields(focused: AXUIElementRef) -> AxFields {
        let role = read_string_attr(focused, "AXRole").unwrap_or_default();
        if role == "AXSecureTextField" {
            return AxFields {
                role,
                ..AxFields::default()
            };
        }
        AxFields {
            role,
            subrole: read_string_attr(focused, "AXSubrole").unwrap_or_default(),
            role_desc: read_string_attr(focused, "AXRoleDescription").unwrap_or_default(),
            title: read_string_attr(focused, "AXTitle").unwrap_or_default(),
            label: read_string_attr(focused, "AXLabel").unwrap_or_default(),
            value: read_string_attr(focused, "AXValue").unwrap_or_default(),
            placeholder: read_string_attr(focused, "AXPlaceholderValue").unwrap_or_default(),
            document: read_string_attr(focused, "AXDocument").unwrap_or_default(),
            url: read_string_attr(focused, "AXURL").unwrap_or_default(),
            identifier: read_string_attr(focused, "AXIdentifier").unwrap_or_default(),
            dom_identifier: read_string_attr(focused, "AXDOMIdentifier").unwrap_or_default(),
            filename: read_string_attr(focused, "AXFilename").unwrap_or_default(),
            help: read_string_attr(focused, "AXHelp").unwrap_or_default(),
            description: read_string_attr(focused, "AXDescription").unwrap_or_default(),
            selected_text: read_string_attr(focused, "AXSelectedText").unwrap_or_default(),
            range_text: read_range_text(focused).unwrap_or_default(),
            window: read_window_title(focused).unwrap_or_default(),
        }
    }

    pub fn is_secure_focus() -> bool {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return false;
            }
            let attr = CFString::new("AXFocusedUIElement");
            let mut focused_raw: CFTypeRef = std::ptr::null();
            let err =
                AXUIElementCopyAttributeValue(system, attr.as_concrete_TypeRef(), &mut focused_raw);
            let secure = if err != AX_ERROR_SUCCESS || focused_raw.is_null() {
                false
            } else {
                let focused = focused_raw as AXUIElementRef;
                read_string_attr(focused, "AXRole").as_deref() == Some("AXSecureTextField")
            };
            if !focused_raw.is_null() {
                CFRelease(focused_raw);
            }
            CFRelease(system as CFTypeRef);
            secure
        }
    }

    fn append_tree_node(
        out: &mut String,
        element: AXUIElementRef,
        depth: u32,
        max_depth: u32,
        state: &mut TreeWalkState,
    ) {
        if depth > max_depth || state.nodes >= state.max_nodes || out.len() >= state.max_chars {
            return;
        }
        if element.is_null() || !state.seen.insert(element as usize) {
            return;
        }
        state.nodes += 1;
        let fields = read_focused_fields(element);
        if fields.role == "AXSecureTextField" {
            return;
        }
        let indent = "  ".repeat(depth as usize);
        let mut parts = Vec::new();
        push_tree_part(&mut parts, "role", &fields.role, 48);
        push_tree_part(&mut parts, "subrole", &fields.subrole, 72);
        push_tree_part(&mut parts, "roleDesc", &fields.role_desc, 48);
        push_tree_part(&mut parts, "title", &fields.title, 120);
        push_tree_part(&mut parts, "label", &fields.label, 160);
        push_tree_part(&mut parts, "value", &fields.value, 180);
        push_tree_part(&mut parts, "placeholder", &fields.placeholder, 120);
        push_tree_part(&mut parts, "description", &fields.description, 160);
        push_tree_part(&mut parts, "selected", &fields.selected_text, 120);
        push_tree_part(&mut parts, "text", &fields.range_text, 240);
        push_tree_part(&mut parts, "url", &fields.url, 160);
        push_tree_part(&mut parts, "document", &fields.document, 160);
        push_tree_part(&mut parts, "identifier", &fields.identifier, 120);
        push_tree_part(&mut parts, "domIdentifier", &fields.dom_identifier, 120);
        push_tree_part(&mut parts, "filename", &fields.filename, 160);
        push_tree_part(&mut parts, "help", &fields.help, 160);
        if !parts.is_empty() {
            let _ =
                std::fmt::Write::write_fmt(out, format_args!("{indent}- {}\n", parts.join(" ")));
        }
        if out.len() >= state.max_chars {
            return;
        }
        for attr in AX_TREE_CHILD_ARRAY_ATTRS {
            append_tree_child_array(out, element, attr, depth, max_depth, state);
            if state.nodes >= state.max_nodes || out.len() >= state.max_chars {
                break;
            }
        }
        for attr in AX_TREE_CHILD_ELEMENT_ATTRS {
            append_tree_child_element(out, element, attr, depth, max_depth, state);
            if state.nodes >= state.max_nodes || out.len() >= state.max_chars {
                break;
            }
        }
    }

    struct TreeWalkState {
        nodes: u32,
        max_nodes: u32,
        max_chars: usize,
        seen: HashSet<usize>,
    }

    fn clip_tree(s: &str, max: usize) -> String {
        s.chars().take(max).collect()
    }

    fn push_tree_part(parts: &mut Vec<String>, key: &str, value: &str, max: usize) {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        parts.push(format!("{key}={}", clip_tree(trimmed, max)));
    }

    fn append_tree_child_array(
        out: &mut String,
        element: AXUIElementRef,
        attr: &str,
        depth: u32,
        max_depth: u32,
        state: &mut TreeWalkState,
    ) {
        unsafe {
            let children_ref = match copy_attr(element, attr) {
                Some(c) => c,
                None => return,
            };
            if CFGetTypeID(children_ref) != CFArrayGetTypeID() {
                CFRelease(children_ref);
                return;
            }
            let count = CFArrayGetCount(children_ref);
            for i in 0..count {
                let child = CFArrayGetValueAtIndex(children_ref, i);
                if child.is_null() {
                    continue;
                }
                append_tree_node(out, child as AXUIElementRef, depth + 1, max_depth, state);
                if state.nodes >= state.max_nodes || out.len() >= state.max_chars {
                    break;
                }
            }
            CFRelease(children_ref);
        }
    }

    fn append_tree_child_element(
        out: &mut String,
        element: AXUIElementRef,
        attr: &str,
        depth: u32,
        max_depth: u32,
        state: &mut TreeWalkState,
    ) {
        unsafe {
            let child_ref = match copy_attr(element, attr) {
                Some(c) => c,
                None => return,
            };
            append_tree_node(
                out,
                child_ref as AXUIElementRef,
                depth + 1,
                max_depth,
                state,
            );
            CFRelease(child_ref);
        }
    }

    fn format_tree_from_root(
        prefix: &str,
        root: AXUIElementRef,
        max_depth: u32,
        max_nodes: u32,
        max_chars: usize,
    ) -> Option<String> {
        if root.is_null() {
            return None;
        }
        let mut buf = format!("{prefix}:\n");
        let mut state = TreeWalkState {
            nodes: 0,
            max_nodes,
            max_chars,
            seen: HashSet::new(),
        };
        append_tree_node(&mut buf, root, 0, max_depth, &mut state);
        if buf.len() <= prefix.len() + 2 {
            None
        } else {
            Some(buf.chars().take(max_chars).collect())
        }
    }

    pub fn focused_ax_tree(max_depth: u32, max_nodes: u32, max_chars: usize) -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let attr = CFString::new("AXFocusedUIElement");
            let mut focused_raw: CFTypeRef = std::ptr::null();
            let err =
                AXUIElementCopyAttributeValue(system, attr.as_concrete_TypeRef(), &mut focused_raw);
            let out = if err != AX_ERROR_SUCCESS || focused_raw.is_null() {
                None
            } else {
                format_tree_from_root(
                    "ax_tree",
                    focused_raw as AXUIElementRef,
                    max_depth,
                    max_nodes,
                    max_chars,
                )
            };
            if !focused_raw.is_null() {
                CFRelease(focused_raw);
            }
            CFRelease(system as CFTypeRef);
            out
        }
    }

    pub fn focused_window_ax_tree(
        max_depth: u32,
        max_nodes: u32,
        max_chars: usize,
    ) -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let focused_app = match copy_attr(system, "AXFocusedApplication") {
                Some(v) => v,
                None => {
                    CFRelease(system as CFTypeRef);
                    return None;
                }
            };
            let out = match copy_attr(focused_app as AXUIElementRef, "AXFocusedWindow") {
                Some(win) => {
                    let tree = format_tree_from_root(
                        "ax_window_tree",
                        win as AXUIElementRef,
                        max_depth,
                        max_nodes,
                        max_chars,
                    );
                    CFRelease(win);
                    tree
                }
                None => format_tree_from_root(
                    "ax_app_tree",
                    focused_app as AXUIElementRef,
                    max_depth,
                    max_nodes,
                    max_chars,
                ),
            };
            CFRelease(focused_app);
            CFRelease(system as CFTypeRef);
            out
        }
    }

    pub fn focused_ax_snapshot() -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let attr = CFString::new("AXFocusedUIElement");
            let mut focused_raw: CFTypeRef = std::ptr::null();
            let err =
                AXUIElementCopyAttributeValue(system, attr.as_concrete_TypeRef(), &mut focused_raw);

            let out = if err != AX_ERROR_SUCCESS || focused_raw.is_null() {
                None
            } else {
                let focused = focused_raw as AXUIElementRef;
                let fields = read_focused_fields(focused);
                format_snapshot(&fields)
            };

            if !focused_raw.is_null() {
                CFRelease(focused_raw);
            }
            CFRelease(system as CFTypeRef);
            out
        }
    }

    pub fn focused_ax_diagnostics(snapshot_present: bool, tree_present: bool) -> AxDiagnostics {
        unsafe {
            let trusted = Some(accessibility_trusted());
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return AxDiagnostics {
                    trusted,
                    focused_element_present: false,
                    focused_role: None,
                    focused_window_title: None,
                    snapshot_present,
                    tree_present,
                    reason: ax_diagnostics_reason(
                        trusted,
                        false,
                        None,
                        snapshot_present,
                        tree_present,
                    ),
                };
            }
            let attr = CFString::new("AXFocusedUIElement");
            let mut focused_raw: CFTypeRef = std::ptr::null();
            let err =
                AXUIElementCopyAttributeValue(system, attr.as_concrete_TypeRef(), &mut focused_raw);
            let (focused_element_present, focused_role, focused_window_title) =
                if err != AX_ERROR_SUCCESS || focused_raw.is_null() {
                    (false, None, None)
                } else {
                    let focused = focused_raw as AXUIElementRef;
                    (
                        true,
                        read_string_attr(focused, "AXRole"),
                        read_window_title(focused)
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty()),
                    )
                };
            if !focused_raw.is_null() {
                CFRelease(focused_raw);
            }
            CFRelease(system as CFTypeRef);
            let reason = ax_diagnostics_reason(
                trusted,
                focused_element_present,
                focused_role.as_deref(),
                snapshot_present,
                tree_present,
            );
            AxDiagnostics {
                trusted,
                focused_element_present,
                focused_role,
                focused_window_title,
                snapshot_present,
                tree_present,
                reason,
            }
        }
    }

    pub fn focused_window_geometry() -> Option<super::WindowGeometry> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let focused_app = match copy_attr(system, "AXFocusedApplication") {
                Some(v) => v,
                None => return None,
            };
            let win = copy_attr(focused_app as AXUIElementRef, "AXFocusedWindow");
            let geom = match win {
                Some(w) => {
                    let pos = read_point(w as AXUIElementRef, "AXPosition");
                    let size = read_size(w as AXUIElementRef, "AXSize");
                    CFRelease(w);
                    match (pos, size) {
                        (Some((x, y)), Some((w, h))) => Some(super::WindowGeometry { x, y, w, h }),
                        _ => None,
                    }
                }
                None => None,
            };
            CFRelease(focused_app);
            CFRelease(system as CFTypeRef);
            geom
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            AX_TEXT_MARKER_RANGE_ATTRS, AX_TEXT_MARKER_STRING_ATTRS, AX_TREE_CHILD_ARRAY_ATTRS,
            AX_TREE_CHILD_ELEMENT_ATTRS,
        };

        #[test]
        fn tree_walk_includes_window_and_selection_fallback_attrs() {
            assert!(AX_TREE_CHILD_ARRAY_ATTRS.contains(&"AXWindows"));
            assert!(AX_TREE_CHILD_ARRAY_ATTRS.contains(&"AXMenuBar"));
            assert!(AX_TREE_CHILD_ARRAY_ATTRS.contains(&"AXVisibleItems"));
            assert!(AX_TREE_CHILD_ARRAY_ATTRS.contains(&"AXSelectedCells"));
            assert!(AX_TREE_CHILD_ELEMENT_ATTRS.contains(&"AXFocusedUIElement"));
            assert!(AX_TREE_CHILD_ELEMENT_ATTRS.contains(&"AXMainWindow"));
            assert!(AX_TREE_CHILD_ELEMENT_ATTRS.contains(&"AXDefaultButton"));
        }

        #[test]
        fn text_marker_fallback_uses_visible_and_selected_ranges() {
            assert!(AX_TEXT_MARKER_RANGE_ATTRS.contains(&"AXVisibleTextMarkerRange"));
            assert!(AX_TEXT_MARKER_RANGE_ATTRS.contains(&"AXSelectedTextMarkerRange"));
            assert!(AX_TEXT_MARKER_STRING_ATTRS.contains(&"AXStringForTextMarkerRange"));
            assert!(AX_TEXT_MARKER_STRING_ATTRS.contains(&"AXAttributedStringForTextMarkerRange"));
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::focused_ax_snapshot;

#[cfg(target_os = "macos")]
pub use imp::focused_ax_tree;

#[cfg(target_os = "macos")]
pub use imp::focused_window_ax_tree;

#[cfg(target_os = "macos")]
pub use imp::focused_ax_diagnostics;

#[cfg(target_os = "macos")]
pub use imp::focused_window_title;

#[cfg(target_os = "macos")]
pub use imp::is_secure_focus;

#[cfg(target_os = "macos")]
pub use imp::focused_window_geometry;

/// `Some(true/false)` on macOS (whether this app is allowed in Accessibility settings). `None` on other platforms.
#[cfg(target_os = "macos")]
pub fn accessibility_trust_status() -> Option<bool> {
    Some(imp::accessibility_trusted())
}

#[cfg(not(target_os = "macos"))]
pub fn focused_ax_snapshot() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn focused_ax_tree(_max_depth: u32, _max_nodes: u32, _max_chars: usize) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_ax_tree(
    _max_depth: u32,
    _max_nodes: u32,
    _max_chars: usize,
) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn focused_ax_diagnostics(snapshot_present: bool, tree_present: bool) -> AxDiagnostics {
    AxDiagnostics {
        trusted: None,
        focused_element_present: false,
        focused_role: None,
        focused_window_title: None,
        snapshot_present,
        tree_present,
        reason: "unavailable_on_platform",
    }
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_title() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn is_secure_focus() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_geometry() -> Option<WindowGeometry> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_trust_status() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_fields() -> AxFields {
        AxFields {
            role: "AXTextField".into(),
            role_desc: "text field".into(),
            title: "Email".into(),
            value: "alice@example.com".into(),
            help: "Enter your email".into(),
            description: "Primary email address".into(),
            selected_text: "alice".into(),
            window: "Compose".into(),
            ..AxFields::default()
        }
    }

    #[test]
    fn format_snapshot_emits_all_non_empty_fields_in_order() {
        let s = format_snapshot(&base_fields()).expect("some");
        let lines: Vec<&str> = s.split('\n').collect();
        assert_eq!(
            lines,
            vec![
                "role=AXTextField",
                "roleDesc=text field",
                "title=Email",
                "value=alice@example.com",
                "help=Enter your email",
                "description=Primary email address",
                "selected=alice",
                "window=Compose",
            ]
        );
    }

    #[test]
    fn format_snapshot_skips_secure_text_field() {
        let mut f = base_fields();
        f.role = "AXSecureTextField".into();
        f.value = "hunter2".into();
        assert_eq!(format_snapshot(&f), None);
    }

    #[test]
    fn ax_diagnostics_reason_prioritizes_untrusted() {
        assert_eq!(
            ax_diagnostics_reason(Some(false), true, Some("AXTextField"), true, false),
            "accessibility_untrusted"
        );
    }

    #[test]
    fn ax_diagnostics_reason_reports_focused_tree_fallback() {
        assert_eq!(
            ax_diagnostics_reason(Some(true), true, Some("AXWebArea"), false, true),
            "focused_tree_fallback"
        );
    }

    #[test]
    fn ax_diagnostics_reason_reports_empty_fields() {
        assert_eq!(
            ax_diagnostics_reason(Some(true), true, Some("AXGroup"), false, false),
            "focused_element_fields_empty"
        );
    }

    #[test]
    fn format_snapshot_returns_none_when_all_empty() {
        assert_eq!(format_snapshot(&AxFields::default()), None);
    }

    #[test]
    fn format_snapshot_omits_empty_fields() {
        let f = AxFields {
            role: "AXButton".into(),
            title: "Send".into(),
            ..AxFields::default()
        };
        assert_eq!(
            format_snapshot(&f),
            Some("role=AXButton\ntitle=Send".into())
        );
    }

    #[test]
    fn format_snapshot_includes_context_metadata_fields() {
        let f = AxFields {
            role: "AXTextField".into(),
            subrole: "AXSearchField".into(),
            placeholder: "Search or enter website name".into(),
            document: "Example Document".into(),
            url: "https://example.com/path".into(),
            identifier: "omnibox".into(),
            dom_identifier: "search-input".into(),
            filename: "notes.md".into(),
            ..AxFields::default()
        };
        assert_eq!(
            format_snapshot(&f),
            Some(
                "role=AXTextField\nsubrole=AXSearchField\nplaceholder=Search or enter website name\ndocument=Example Document\nurl=https://example.com/path\nidentifier=omnibox\ndomIdentifier=search-input\nfilename=notes.md"
                    .into()
            )
        );
    }

    #[test]
    fn format_snapshot_includes_label_as_visible_text() {
        let f = AxFields {
            role: "AXButton".into(),
            label: "Archive conversation".into(),
            ..AxFields::default()
        };
        assert_eq!(
            format_snapshot(&f),
            Some("role=AXButton\nlabel=Archive conversation".into())
        );
    }

    #[test]
    fn ax_text_signal_accepts_label_and_filename_fields() {
        assert!(ax_text_has_content_signal(
            "ax_tree:\n- role=AXButton label=Archive conversation"
        ));
        assert!(ax_text_has_content_signal(
            "ax_tree:\n- role=AXStaticText filename=roadmap.md"
        ));
    }

    #[test]
    fn format_snapshot_includes_range_text_field() {
        let f = AxFields {
            role: "AXTextArea".into(),
            range_text: "Visible editor line".into(),
            ..AxFields::default()
        };
        assert_eq!(
            format_snapshot(&f),
            Some("role=AXTextArea\ntext=Visible editor line".into())
        );
    }

    #[test]
    fn ax_text_signal_accepts_range_text_field() {
        assert!(ax_text_has_content_signal(
            "ax_tree:\n- role=AXTextArea text=Visible editor line"
        ));
    }

    #[test]
    fn format_snapshot_clips_long_value() {
        let long: String = "x".repeat(1_000);
        let f = AxFields {
            role: "AXTextArea".into(),
            value: long,
            ..AxFields::default()
        };
        let s = format_snapshot(&f).expect("some");
        let value_line = s
            .lines()
            .find(|l| l.starts_with("value="))
            .expect("value line");
        // "value=" prefix (6) + 500 clipped chars.
        assert_eq!(value_line.chars().count(), 6 + AX_VALUE_CHAR_CAP);
    }

    #[test]
    fn format_snapshot_clips_help_description_selected_independently() {
        let long: String = "y".repeat(1_000);
        let f = AxFields {
            role: "AXTextField".into(),
            help: long.clone(),
            description: long.clone(),
            selected_text: long,
            ..AxFields::default()
        };
        let s = format_snapshot(&f).expect("some");
        for prefix in ["help=", "description=", "selected="] {
            let line = s.lines().find(|l| l.starts_with(prefix)).expect("line");
            assert_eq!(
                line.chars().count(),
                prefix.chars().count() + AX_VALUE_CHAR_CAP
            );
        }
    }
}
