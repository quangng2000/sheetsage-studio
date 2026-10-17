import AppKit

// Code-drawn app artwork: a gold melody on a dark piano-roll field.
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.10, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: 210, yRadius: 210).fill()
NSColor(calibratedWhite: 1, alpha: 0.055).setStroke()
for y in stride(from: 220, through: 820, by: 120) {
    let line = NSBezierPath()
    line.move(to: NSPoint(x: 150, y: y))
    line.line(to: NSPoint(x: 875, y: y))
    line.lineWidth = 3
    line.stroke()
}
let gold = NSColor(calibratedRed: 0.91, green: 0.74, blue: 0.40, alpha: 1)
gold.setFill()
for (x, y, width) in [(170, 300, 170), (350, 420, 140), (500, 540, 220), (730, 660, 120)] {
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: width, height: 66), xRadius: 18, yRadius: 18).fill()
}
NSColor(calibratedRed: 0.35, green: 0.75, blue: 0.66, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 170, y: 164, width: 680, height: 14), xRadius: 7, yRadius: 7).fill()
NSGraphicsContext.restoreGraphicsState()
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try bitmap.representation(using: .png, properties: [:])!.write(to: destination)
