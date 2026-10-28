pub fn build() {
    cc::Build::new()
        .file("../../mac/native/ocr_macos.m")
        .flag("-fobjc-arc")
        .compile("qbank_ocr");
    for framework in ["Foundation", "Vision", "AppKit", "ImageIO", "CoreGraphics"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rerun-if-changed=../../mac/native/ocr_macos.m");
}
