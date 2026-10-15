#import <AppKit/AppKit.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>

// The bridge owns every returned C string; Rust releases it with qbank_ocr_free.
static char *jsonString(NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    if (!data) return strdup("{\"error\":\"系统识别返回了无效数据\"}");
    return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}
void qbank_ocr_free(char *value) { free(value); }
bool qbank_clipboard_write(const char *value) {
    @autoreleasepool {
        @try {
            NSString *text = [NSString stringWithUTF8String:value];
            if (!text) return false;
            NSPasteboard *board = NSPasteboard.generalPasteboard;
            [board clearContents];
            return [board setString:text forType:NSPasteboardTypeString];
        } @catch (NSException *exception) { return false; }
    }
}

char *qbank_ocr_image(const unsigned char *bytes, size_t length) {
    @autoreleasepool {
        @try {
            NSData *data = [NSData dataWithBytes:bytes length:length];
            VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
            request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
            request.usesLanguageCorrection = NO;
            NSArray *supported = [request supportedRecognitionLanguagesAndReturnError:nil];
            NSMutableArray *languages = [NSMutableArray array];
            for (NSString *language in @[@"zh-Hans", @"zh-Hant", @"en-US"]) {
                if ([supported containsObject:language]) [languages addObject:language];
            }
            if (languages.count) request.recognitionLanguages = languages;
            request.customWords = @[@"HarmonyOS", @"ArkTS", @"UIAbility", @"Navigation"];
            VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithData:data options:@{}];
            NSError *error = nil;
            if (![handler performRequests:@[request] error:&error])
                return jsonString(@{@"error": error.localizedDescription ?: @"系统 OCR 识别失败"});
            NSMutableArray *lines = [NSMutableArray array];
            NSMutableArray *texts = [NSMutableArray array];
            // Vision returns observations in reading order. Normalized bounds use a top-left origin.
            for (VNRecognizedTextObservation *observation in request.results) {
                VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
                if (!candidate.string.length) continue;
                CGRect b = observation.boundingBox;
                [texts addObject:candidate.string];
                [lines addObject:@{@"text": candidate.string, @"confidence": @(candidate.confidence),
                    @"bounds": @[@(b.origin.x), @(1-b.origin.y-b.size.height), @(b.size.width), @(b.size.height)]}];
            }
            return jsonString(@{@"engine": @"Apple Vision", @"text": [texts componentsJoinedByString:@"\n"], @"lines": lines});
        } @catch (NSException *exception) {
            return jsonString(@{@"error": exception.reason ?: @"系统 OCR 异常"});
        }
    }
}

char *qbank_ocr_clipboard(void) {
    @autoreleasepool {
        NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
        NSData *data = [pasteboard dataForType:NSPasteboardTypePNG];
        if (!data) {
            NSData *tiff = [pasteboard dataForType:NSPasteboardTypeTIFF];
            if (tiff && tiff.length <= 80 * 1024 * 1024) {
                NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:tiff];
                if (bitmap.pixelsWide * bitmap.pixelsHigh <= 30000000)
                    data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            }
        }
        if (data) {
            if (data.length > 20 * 1024 * 1024) return jsonString(@{@"error": @"图片超过 20 MB，请裁剪后重试"});
            return jsonString(@{@"image": [@"data:image/png;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]]});
        }
        NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
        if (text.length > 16000) return jsonString(@{@"error": @"文字过长，请每次复制一道题"});
        return jsonString(@{@"text": text ?: @""});
    }
}

bool qbank_capture_allowed(void) {
    return CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
}
