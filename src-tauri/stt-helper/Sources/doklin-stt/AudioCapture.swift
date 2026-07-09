// Microphone capture: AVAudioEngine tap → 16 kHz mono Float32 ring buffer.
//
// The capture is *gated*: samples only accumulate while the gate is open
// (the talk key closes it between utterances). The engine itself keeps
// running for the whole session so the mic HUD level meter stays live and
// reopening the gate is instant. While the gate is closed a short *pre-roll*
// ring holds the last fraction of a second; opening the gate splices it in,
// so speech that starts a beat before the talk key registers (the host waits
// ~200 ms to tell a talk-hold from a spacebar tap) isn't clipped. It never
// leaves the process and dies with the gate's next close.
//
// Energy bookkeeping (RMS per tap callback) doubles as a VAD-lite: the
// transcribe loop skips transcribing buffers that never contained voice
// (Whisper hallucinates "Thank you." on pure silence).
import AVFoundation
import Foundation

final class AudioCapture {
    static let sampleRate = 16_000.0
    /// RMS above this counts as voice. Conservative; typical speech is >0.03.
    static let voiceRMS: Float = 0.012
    /// Gate-closed lookback spliced in when the gate opens.
    static let prerollSamples = Int(0.5 * sampleRate)

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

    private let lock = NSLock()
    private var samples: [Float] = []
    private var preroll: [Float] = []
    private var gate = false
    private var voiced = false  // any voice since the last take()
    private var lastLevelEmit = Date.distantPast

    var gateOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return gate
    }

    func setGate(_ open: Bool) {
        lock.lock()
        if open && !gate {
            samples.append(contentsOf: preroll)
        }
        preroll.removeAll()
        gate = open
        lock.unlock()
    }

    func start() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            throw NSError(
                domain: "doklin-stt", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no audio input device"])
        }
        converter = AVAudioConverter(from: inFormat, to: outFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        samples.removeAll()
        preroll.removeAll()
        voiced = false
        gate = false
        lock.unlock()
    }

    private func consume(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0, let ch = out.floatChannelData?[0] else { return }
        let chunk = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))

        var sum: Float = 0
        for s in chunk { sum += s * s }
        let rms = (sum / Float(chunk.count)).squareRoot()

        lock.lock()
        let now = Date()
        if rms > Self.voiceRMS, gate { voiced = true }
        if gate {
            samples.append(contentsOf: chunk)
        } else {
            preroll.append(contentsOf: chunk)
            if preroll.count > Self.prerollSamples {
                preroll.removeFirst(preroll.count - Self.prerollSamples)
            }
        }
        // Waveform feed for the HUD, throttled to ~12 Hz. Emitted gate-closed
        // too (at the real level) so the meter visibly flatlines when paused.
        let shouldEmit = now.timeIntervalSince(lastLevelEmit) > 0.08
        if shouldEmit { lastLevelEmit = now }
        let gateNow = gate
        lock.unlock()

        if shouldEmit {
            emit(["event": "level", "rms": Double(rms), "gate": gateNow])
        }
    }

    /// Snapshot for the partial-transcription loop (buffer stays in place).
    func snapshot() -> (samples: [Float], voiced: Bool, gate: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (samples, voiced, gate)
    }

    /// Take the utterance out of the buffer (finalize) and reset voice tracking.
    func take() -> (samples: [Float], voiced: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let out = (samples, voiced)
        samples.removeAll()
        voiced = false
        return out
    }

    /// Trim a never-voiced buffer so open-mic silence can't grow unbounded.
    func trimSilence(keepLast seconds: Double) {
        lock.lock()
        defer { lock.unlock() }
        guard !voiced else { return }
        let keep = Int(seconds * Self.sampleRate)
        if samples.count > keep { samples.removeFirst(samples.count - keep) }
    }
}
