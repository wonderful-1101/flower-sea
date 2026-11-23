import Foundation
import Vision
import CoreImage
import AppKit

/// Generates continuous grayscale foreground alpha masks for every PNG in inputDir using Apple Vision.
func run() throws {
    let args = CommandLine.arguments
    guard args.count >= 3 else {
        fputs("Usage: matte_frames <input_dir> <mask_dir>\n", stderr)
        exit(2)
    }

    let inputDir = URL(fileURLWithPath: args[1], isDirectory: true)
    let maskDir = URL(fileURLWithPath: args[2], isDirectory: true)
    try FileManager.default.createDirectory(at: maskDir, withIntermediateDirectories: true)

    let pngURLs = try FileManager.default
        .contentsOfDirectory(at: inputDir, includingPropertiesForKeys: nil)
        .filter { $0.pathExtension.lowercased() == "png" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    let graySpace = CGColorSpaceCreateDeviceGray()
    var processed = 0

    for srcURL in pngURLs {
        autoreleasepool {
            let request = VNGenerateForegroundInstanceMaskRequest()
            let handler = VNImageRequestHandler(url: srcURL, options: [:])
            do {
                try handler.perform([request])
                guard let observation = request.results?.first else {
                    fputs("Warning: no foreground mask for \(srcURL.lastPathComponent)\n", stderr)
                    return
                }
                let maskBuffer = try observation.generateScaledMaskForImage(
                    forInstances: observation.allInstances,
                    from: handler
                )
                let ciImage = CIImage(cvPixelBuffer: maskBuffer)
                guard let cgImage = ciContext.createCGImage(
                    ciImage,
                    from: ciImage.extent,
                    format: .L8,
                    colorSpace: graySpace
                ) else {
                    fputs("Warning: failed to create CGImage for \(srcURL.lastPathComponent)\n", stderr)
                    return
                }
                let rep = NSBitmapImageRep(cgImage: cgImage)
                guard let pngData = rep.representation(using: .png, properties: [:]) else {
                    fputs("Warning: failed to encode PNG for \(srcURL.lastPathComponent)\n", stderr)
                    return
                }
                let destURL = maskDir.appendingPathComponent(srcURL.lastPathComponent)
                try pngData.write(to: destURL)
                processed += 1
            } catch {
                fputs("Error matting \(srcURL.lastPathComponent): \(error)\n", stderr)
            }
        }
    }

    print("Matted \(processed)/\(pngURLs.count) frames -> \(maskDir.path)")
    if processed == 0 && !pngURLs.isEmpty {
        exit(1)
    }
}

try run()
