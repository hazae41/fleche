import { Result } from '@hazae41/result'
import "@hazae41/symbol-dispose-polyfill"
import type { AppProps } from 'next/app'
import '../styles/globals.css'

Result.debug = true

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
