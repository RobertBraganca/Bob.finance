export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

/**
 * Manda um arquivo para fora do app: no celular (e onde o sistema tiver),
 * a folha de compartilhar nativa com o arquivo anexado (WhatsApp, e-mail);
 * sem ela, baixa o arquivo. `cancelled` quando a pessoa fecha a folha sem
 * escolher destino: quem chama não deve tratar isso como envio.
 */
export async function shareOrDownload(bytes: Uint8Array, fileName: string, title: string): Promise<ShareOutcome> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const file = new File([blob], fileName, { type: 'application/pdf' })

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
      // Outro erro da folha (permissão, tamanho): cai para o download.
    }
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
