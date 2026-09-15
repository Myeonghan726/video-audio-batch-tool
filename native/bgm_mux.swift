import Foundation
import AVFoundation
import CoreMedia

enum MuxError: Error, CustomStringConvertible {
    case usage
    case noVideo
    case noAudio
    case invalidOffset
    case cannotCreateTrack
    case cannotExport
    case exportFailed(String)

    var description: String {
        switch self {
        case .usage: return "参数错误：bgm_mux <video> <audio> <startSeconds> <output>"
        case .noVideo: return "源文件中没有可用的视频轨"
        case .noAudio: return "BGM 文件中没有可用的音轨"
        case .invalidOffset: return "BGM 开始时间超出了音乐长度"
        case .cannotCreateTrack: return "无法创建合成音视频轨"
        case .cannotExport: return "无法创建导出任务"
        case .exportFailed(let message): return "导出失败：\(message)"
        }
    }
}

func exportComposition(_ composition: AVMutableComposition, to outputURL: URL, preset: String, audioMix: AVAudioMix? = nil) throws {
    guard let exporter = AVAssetExportSession(asset: composition, presetName: preset) else {
        throw MuxError.cannotExport
    }
    exporter.outputURL = outputURL
    exporter.outputFileType = .mp4
    exporter.shouldOptimizeForNetworkUse = true
    exporter.audioMix = audioMix

    let semaphore = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously { semaphore.signal() }
    semaphore.wait()

    switch exporter.status {
    case .completed:
        return
    case .failed, .cancelled:
        throw MuxError.exportFailed(exporter.error?.localizedDescription ?? "未知错误")
    default:
        throw MuxError.exportFailed("导出任务未完成")
    }
}

func run() throws {
    guard CommandLine.arguments.count == 8 else { throw MuxError.usage }

    let videoURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let audioURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let startSeconds = max(0, Double(CommandLine.arguments[3]) ?? 0)
    let outputURL = URL(fileURLWithPath: CommandLine.arguments[4])
    let mixOriginal = CommandLine.arguments[5] == "mix"
    let originalDb = Double(CommandLine.arguments[6]) ?? 0
    let bgmDb = Double(CommandLine.arguments[7]) ?? -8

    let videoAsset = AVURLAsset(url: videoURL)
    let audioAsset = AVURLAsset(url: audioURL)

    guard let sourceVideoTrack = videoAsset.tracks(withMediaType: .video).first else {
        throw MuxError.noVideo
    }
    guard let sourceAudioTrack = audioAsset.tracks(withMediaType: .audio).first else {
        throw MuxError.noAudio
    }
    let sourceOriginalTrack = mixOriginal ? videoAsset.tracks(withMediaType: .audio).first : nil

    let videoDuration = videoAsset.duration
    let audioDuration = audioAsset.duration
    let audioSeconds = CMTimeGetSeconds(audioDuration)
    guard audioSeconds.isFinite && audioSeconds > 0 else { throw MuxError.invalidOffset }

    let composition = AVMutableComposition()
    guard let videoTrack = composition.addMutableTrack(
        withMediaType: .video,
        preferredTrackID: kCMPersistentTrackID_Invalid
    ), let audioTrack = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
        throw MuxError.cannotCreateTrack
    }
    let originalTrack = sourceOriginalTrack == nil ? nil : composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
    )

    try videoTrack.insertTimeRange(
        CMTimeRange(start: .zero, duration: videoDuration),
        of: sourceVideoTrack,
        at: .zero
    )
    videoTrack.preferredTransform = sourceVideoTrack.preferredTransform

    if let sourceOriginalTrack, let originalTrack {
        try originalTrack.insertTimeRange(
            CMTimeRange(start: .zero, duration: videoDuration),
            of: sourceOriginalTrack,
            at: .zero
        )
    }

    // 起点超过 BGM 时长时从头循环；如果 15 秒跨过音乐末尾，也会接续到开头。
    var sourceStart = CMTime(seconds: startSeconds.truncatingRemainder(dividingBy: audioSeconds), preferredTimescale: 600)
    var destination = CMTime.zero
    while CMTimeCompare(destination, videoDuration) < 0 {
        let remainingAudio = CMTimeSubtract(audioDuration, sourceStart)
        let remainingVideo = CMTimeSubtract(videoDuration, destination)
        let insertDuration = CMTimeMinimum(remainingAudio, remainingVideo)
        guard CMTimeCompare(insertDuration, .zero) > 0 else { throw MuxError.invalidOffset }
        try audioTrack.insertTimeRange(
            CMTimeRange(start: sourceStart, duration: insertDuration),
            of: sourceAudioTrack,
            at: destination
        )
        destination = CMTimeAdd(destination, insertDuration)
        sourceStart = .zero
    }

    try? FileManager.default.removeItem(at: outputURL)

    let compatible = AVAssetExportSession.exportPresets(compatibleWith: composition)
    let preset = compatible.contains(AVAssetExportPresetPassthrough)
        ? AVAssetExportPresetPassthrough
        : AVAssetExportPresetHighestQuality
    let audioMix = AVMutableAudioMix()
    let bgmParameters = AVMutableAudioMixInputParameters(track: audioTrack)
    bgmParameters.setVolume(Float(pow(10.0, bgmDb / 20.0)), at: .zero)
    var parameters: [AVAudioMixInputParameters] = [bgmParameters]
    if let originalTrack {
        let originalParameters = AVMutableAudioMixInputParameters(track: originalTrack)
        originalParameters.setVolume(Float(pow(10.0, originalDb / 20.0)), at: .zero)
        parameters.append(originalParameters)
    }
    audioMix.inputParameters = parameters
    try exportComposition(composition, to: outputURL, preset: preset, audioMix: audioMix)
}

do {
    try run()
    print("OK")
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
