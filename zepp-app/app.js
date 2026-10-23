import { BaseApp } from '@zeppos/zml/base-app'

App(
  BaseApp({
    globalData: {},
    onCreate() {},
    onDestroy() {},
    // Spoken answers: the phone sends the MP3 with zml file transfer; once it has fully arrived,
    // the page (which registers globalData.onSpeechFile while open) plays it.
    onReceivedFile(file) {
      if (!file || !file.on) return
      file.on('change', (event) => {
        const state = event && event.data && event.data.readyState
        const play = this.globalData.onSpeechFile
        const note = this.globalData.onSpeechNote // the page reports it to the PC log
        if (state === 'transferred' && play) play(file.filePath, file.params || {})
        else if (note) note(`file ${file.fileName || '?'}: ${state}${play ? '' : ' (no page open)'}`)
      })
    },
  }),
)
