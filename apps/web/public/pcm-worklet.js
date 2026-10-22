/* CaptionDoor, MIT. No microphone input. Receives only the selected remote stream.
 * Stateful 33-tap windowed-sinc resampling; PCM samples are not merely relabelled.
 * The output graph is silent. Audio is never recorded or retained by the app.
 */
class CaptionDoorPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = [];
    this.base = 0;
    this.total = 0;
    this.position = 16;
    this.ratio = sampleRate / 16000;
    this.radius = 16;
    this.output = [];
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "stop") {
        this.stopped = true;
        this.input = [];
        this.output = [];
      }
    };
  }
  process(inputs, outputs) {
    for (const channels of outputs)
      for (const channel of channels) channel.fill(0);
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.input.push(value / channels.length);
      this.total++;
    }
    const cutoff = Math.min(1, 16000 / sampleRate) * 0.9;
    while (this.position + this.radius < this.total) {
      const center = Math.floor(this.position);
      let weighted = 0;
      let weight = 0;
      for (
        let tap = center - this.radius + 1;
        tap <= center + this.radius;
        tap++
      ) {
        const distance = tap - this.position;
        const sinc =
          distance === 0
            ? cutoff
            : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / this.radius);
        const coefficient = sinc * window;
        weight += coefficient;
        weighted += (this.input[tap - this.base] || 0) * coefficient;
      }
      this.output.push(Math.max(-1, Math.min(1, weighted / weight)));
      this.position += this.ratio;
      if (this.output.length === 1600) {
        const bytes = new ArrayBuffer(3200);
        const data = new DataView(bytes);
        for (let i = 0; i < 1600; i++)
          data.setInt16(
            i * 2,
            Math.round(
              this.output[i] < 0
                ? this.output[i] * 32768
                : this.output[i] * 32767,
            ),
            true,
          );
        this.output = [];
        this.port.postMessage({ type: "pcm", pcm: bytes }, [bytes]);
      }
    }
    const discard = Math.max(
      0,
      Math.floor(this.position) - this.radius - this.base,
    );
    if (discard) {
      this.input.splice(0, discard);
      this.base += discard;
    }
    return true;
  }
}
registerProcessor("captiondoor-pcm", CaptionDoorPcmProcessor);
