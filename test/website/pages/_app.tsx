import { Debug } from '@hazae41/result'
import type { AppProps } from 'next/app'
import '../styles/globals.css'

Debug.debug = true

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
