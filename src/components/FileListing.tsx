import type { FC } from 'react'
import type { ParsedUrlQuery } from 'querystring'
import type { OdFolderChildren, OdFileObject, OdFolderObject } from '../types'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import { useState, useRef, useEffect } from 'react'
import toast, { Toaster } from 'react-hot-toast'

// Components
import FolderListLayout from './FolderListLayout'
import FolderGridLayout from './FolderGridLayout'
import { PreviewContainer } from './previews/Containers'
import Loading, { LoadingIcon } from './Loading'
import FourOhFour from './FourOhFour'
import Auth from './Auth'

// Utils
import { getStoredToken } from '../utils/protectedRouteHandler'
import useLocalStorage from '../utils/useLocalStorage'
import { queryToPath } from '../utils/queryToPath'
import { getPreviewType, preview } from '../utils/getPreviewType'
import { useProtectedSWRInfinite } from '../utils/fetchWithSWR'
import { getExtension, getRawExtension, getFileIcon } from '../utils/getFileIcon'
import { layouts } from './SwitchLayout'
import {
  DownloadingToast,
  downloadMultipleFiles,
  downloadTreelikeMultipleFiles,
  traverseFolder,
} from './MultiFileDownloader'

// ✅ Dynamic imports for browser-only previews
const MarkdownPreview = dynamic(() => import('./previews/MarkdownPreview'), { ssr: false })
const DefaultPreview = dynamic(() => import('./previews/DefaultPreview'), { ssr: false })
const ImagePreview = dynamic(() => import('./previews/ImagePreview'), { ssr: false })
const TextPreview = dynamic(() => import('./previews/TextPreview'), { ssr: false })
const CodePreview = dynamic(() => import('./previews/CodePreview'), { ssr: false })
const VideoPreview = dynamic(() => import('./previews/VideoPreview'), { ssr: false })
const AudioPreview = dynamic(() => import('./previews/AudioPreview'), { ssr: false })
const PDFPreview = dynamic(() => import('./previews/PDFPreview'), { ssr: false })
const OfficePreview = dynamic(() => import('./previews/OfficePreview'), { ssr: false })
const URLPreview = dynamic(() => import('./previews/URLPreview'), { ssr: false })
const EPUBPreview = dynamic(() => import('./previews/EPUBPreview'), { ssr: false })

interface FileListingProps {
  query?: ParsedUrlQuery
}

const FileListing: FC<FileListingProps> = ({ query }) => {
  const [selected, setSelected] = useState<{ [key: string]: boolean }>({})
  const [totalSelected, setTotalSelected] = useState<0 | 1 | 2>(0)
  const [totalGenerating, setTotalGenerating] = useState(false)
  const [folderGenerating, setFolderGenerating] = useState<{ [key: string]: boolean }>({})

  const router = useRouter()
  const hashedToken = getStoredToken(router.asPath)
  const [layout] = useLocalStorage('preferredLayout', layouts[0])
  const { t } = useTranslation()
  const path = queryToPath(query)
  const { data, error, size, setSize } = useProtectedSWRInfinite(path)

  if (error) {
    if (error.status === 403) {
      router.push('/onedrive-vercel-index-oauth/step-1')
      return <div />
    }
    return (
      <PreviewContainer>
        {error.status === 401 ? <Auth redirect={path} /> : <FourOhFour errorMsg={JSON.stringify(error.message)} />}
      </PreviewContainer>
    )
  }

  if (!data) {
    return (
      <PreviewContainer>
        <Loading loadingText={t('Loading ...')} />
      </PreviewContainer>
    )
  }

  const responses: any[] = data ? ([] as any).concat(...data) : []

  // Folder view
  if ('folder' in responses[0]) {
    const folderChildren = ([] as any).concat(...responses.map(r => r.folder.value)) as OdFolderObject['value']
    const readmeFile = folderChildren.find(c => c.name.toLowerCase() === 'readme.md')
    const getFiles = () => folderChildren.filter(c => !c.folder && c.name !== '.password')

    const genTotalSelected = (selected: { [key: string]: boolean }) => {
      const selectInfo = getFiles().map(c => Boolean(selected[c.id]))
      const [hasT, hasF] = [selectInfo.some(i => i), selectInfo.some(i => !i)]
      return hasT && hasF ? 1 : !hasF ? 2 : 0
    }

    const toggleItemSelected = (id: string) => {
      const val = selected[id] ? Object.fromEntries(Object.entries(selected).filter(([k]) => k !== id)) : { ...selected, [id]: true }
      setSelected(val)
      setTotalSelected(genTotalSelected(val))
    }

    const toggleTotalSelected = () => {
      const newSelected = genTotalSelected(selected) === 2 ? {} : Object.fromEntries(getFiles().map(c => [c.id, true]))
      setSelected(newSelected)
      setTotalSelected(genTotalSelected(newSelected))
    }

    const handleSelectedDownload = () => {
      const folderName = path.substring(path.lastIndexOf('/') + 1)
      const folder = folderName ? decodeURIComponent(folderName) : undefined
      const files = getFiles()
        .filter(c => selected[c.id])
        .map(c => ({
          name: c.name,
          url: `/api/raw/?path=${path}/${encodeURIComponent(c.name)}${hashedToken ? `&odpt=${hashedToken}` : ''}`,
        }))

      if (files.length === 1) {
        if (typeof window !== 'undefined') {
          const el = document.createElement('a')
          el.style.display = 'none'
          document.body.appendChild(el)
          el.href = files[0].url
          el.click()
          el.remove()
        }
      } else if (files.length > 1) {
        setTotalGenerating(true)
        const toastId = toast.loading(<DownloadingToast router={router} />)
        downloadMultipleFiles({ toastId, router, files, folder })
          .then(() => {
            setTotalGenerating(false)
            toast.success(t('Finished downloading selected files.'), { id: toastId })
          })
          .catch(() => {
            setTotalGenerating(false)
            toast.error(t('Failed to download selected files.'), { id: toastId })
          })
      }
    }

    const handleSelectedPermalink = (baseUrl: string) =>
      getFiles()
        .filter(c => selected[c.id])
        .map(c => `${baseUrl}/api/raw/?path=${path}/${encodeURIComponent(c.name)}${hashedToken ? `&odpt=${hashedToken}` : ''}`)
        .join('\n')

    const handleFolderDownload = (folderPath: string, id: string, name?: string) => () => {
      const files = (async function* () {
        for await (const { meta: c, path: p, isFolder, error } of traverseFolder(folderPath)) {
          if (error) {
            toast.error(t('Failed to download folder {{path}}: {{status}} {{message}} Skipped it to continue.', {
              path: p,
              status: error.status,
              message: error.message,
            }))
            continue
          }
          const hashedTokenForPath = getStoredToken(p)
          yield {
            name: c?.name,
            url: `/api/raw/?path=${p}${hashedTokenForPath ? `&odpt=${hashedTokenForPath}` : ''}`,
            path: p,
            isFolder,
          }
        }
      })()
      setFolderGenerating({ ...folderGenerating, [id]: true })
      const toastId = toast.loading(<DownloadingToast router={router} />)
      downloadTreelikeMultipleFiles({ toastId, router, files, basePath: folderPath, folder: name })
        .then(() => setFolderGenerating({ ...folderGenerating, [id]: false }))
        .catch(() => setFolderGenerating({ ...folderGenerating, [id]: false }))
    }

    const folderProps = {
      toast,
      path,
      folderChildren,
      selected,
      toggleItemSelected,
      totalSelected,
      toggleTotalSelected,
      totalGenerating,
      handleSelectedDownload,
      folderGenerating,
      handleSelectedPermalink,
      handleFolderDownload,
    }

    return (
      <>
        <Toaster />
        {layout.name === 'Grid' ? <FolderGridLayout {...folderProps} /> : <FolderListLayout {...folderProps} />}
        {readmeFile && <MarkdownPreview file={readmeFile} path={path} standalone={false} />}
      </>
    )
  }

  // Single file preview
  if ('file' in responses[0] && responses.length === 1) {
    const file = responses[0].file as OdFileObject
    const previewType = getPreviewType(getExtension(file.name), { video: Boolean(file.video) })
    switch (previewType) {
      case preview.image: return <ImagePreview file={file} />
      case preview.text: return <TextPreview file={file} />
      case preview.code: return <CodePreview file={file} />
      case preview.markdown: return <MarkdownPreview file={file} path={path} />
      case preview.video: return <VideoPreview file={file} />
      case preview.audio: return <AudioPreview file={file} />
      case preview.pdf: return <PDFPreview file={file} />
      case preview.office: return <OfficePreview file={file} />
      case preview.epub: return <EPUBPreview file={file} />
      case preview.url: return <URLPreview file={file} />
      default: return <DefaultPreview file={file} />
    }
  }

  return <PreviewContainer><FourOhFour errorMsg={t('Cannot preview {{path}}', { path })} /></PreviewContainer>
}

export default FileListing
