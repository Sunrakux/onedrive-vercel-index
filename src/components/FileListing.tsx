import type { OdFileObject, OdFolderChildren, OdFolderObject } from '../types'
import { ParsedUrlQuery } from 'querystring'
import { FC, useState } from 'react'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'
import dynamic from 'next/dynamic'

import useLocalStorage from '../utils/useLocalStorage'
import { getPreviewType, preview } from '../utils/getPreviewType'
import { useProtectedSWRInfinite } from '../utils/fetchWithSWR'
import { getExtension, getRawExtension, getFileIcon } from '../utils/getFileIcon'
import { getStoredToken } from '../utils/protectedRouteHandler'
import { DownloadingToast, downloadMultipleFiles, downloadTreelikeMultipleFiles, traverseFolder } from './MultiFileDownloader'

import FolderListLayout from './FolderListLayout'
import FolderGridLayout from './FolderGridLayout'
import { layouts } from './SwitchLayout'
import Loading, { LoadingIcon } from './Loading'
import FourOhFour from './FourOhFour'
import Auth from './Auth'
import { PreviewContainer } from './previews/Containers'

// Dynamic import for EPUB (already browser-only)
const EPUBPreview = dynamic(() => import('./previews/EPUBPreview'), { ssr: false })

// Helper: convert URL query to path
const queryToPath = (query?: ParsedUrlQuery) => {
  if (!query) return '/'
  const { path } = query
  if (!path) return '/'
  if (typeof path === 'string') return `/${encodeURIComponent(path)}`
  return `/${path.map(p => encodeURIComponent(p)).join('/')}`
}

const FileListing: FC<{ query?: ParsedUrlQuery }> = ({ query }) => {
  const [selected, setSelected] = useState<{ [key: string]: boolean }>({})
  const [totalSelected, setTotalSelected] = useState<0 | 1 | 2>(0)
  const [totalGenerating, setTotalGenerating] = useState<boolean>(false)
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

  const responses: any[] = data ? [].concat(...data) : []
  const isEmpty = data?.[0]?.length === 0
  const isReachingEnd = isEmpty || (data && typeof data[data.length - 1]?.next === 'undefined')
  const onlyOnePage = data && typeof data[0].next === 'undefined'

  // Browser-only guard
  const isBrowser = typeof window !== 'undefined'

  // Helper: get files excluding folders and .password
  const getFiles = () => {
    if ('folder' in responses[0]) {
      const folderChildren = [].concat(...responses.map(r => r.folder.value)) as OdFolderObject['value']
      return folderChildren.filter(c => !c.folder && c.name !== '.password')
    }
    return []
  }

  // Download selected files safely (browser only)
  const handleSelectedDownload = () => {
    if (!isBrowser) return
    const files = getFiles()
      .filter(c => selected[c.id])
      .map(c => ({
        name: c.name,
        url: `/api/raw/?path=${path}/${encodeURIComponent(c.name)}${hashedToken ? `&odpt=${hashedToken}` : ''}`,
      }))

    if (files.length === 1) {
      const el = document.createElement('a')
      el.style.display = 'none'
      document.body.appendChild(el)
      el.href = files[0].url
      el.click()
      el.remove()
    } else if (files.length > 1) {
      setTotalGenerating(true)
      const toastId = DownloadingToast(router)
      downloadMultipleFiles({ toastId, router, files, folder: undefined })
        .finally(() => setTotalGenerating(false))
    }
  }

  // Folder download (browser only)
  const handleFolderDownload = (folderPath: string, id: string) => {
    if (!isBrowser) return
    const files = (async function* () {
      for await (const { meta: c, path: p, isFolder, error } of traverseFolder(folderPath)) {
        if (!error) yield { name: c?.name, url: `/api/raw/?path=${p}`, path: p, isFolder }
      }
    })()
    setFolderGenerating({ ...folderGenerating, [id]: true })
    const toastId = DownloadingToast(router)
    downloadTreelikeMultipleFiles({ toastId, router, files, basePath: folderPath })
      .finally(() => setFolderGenerating({ ...folderGenerating, [id]: false }))
  }

  // Rendering
  if ('folder' in responses[0]) {
    const folderChildren = [].concat(...responses.map(r => r.folder.value)) as OdFolderObject['value']
    const readmeFile = folderChildren.find(c => c.name.toLowerCase() === 'readme.md')
    const folderProps = {
      toast: null, // toast removed from SSR
      path,
      folderChildren,
      selected,
      toggleItemSelected: (id: string) => {
        setSelected(prev => ({ ...prev, [id]: !prev[id] }))
      },
      totalSelected,
      toggleTotalSelected: () => {
        const allFiles = getFiles()
        const allSelected = allFiles.every(f => selected[f.id])
        if (allSelected) {
          setSelected({})
          setTotalSelected(0)
        } else {
          setSelected(Object.fromEntries(allFiles.map(f => [f.id, true])))
          setTotalSelected(2)
        }
      },
      totalGenerating,
      folderGenerating,
      handleSelectedDownload,
      handleFolderDownload,
      handleSelectedPermalink: () => '',
    }

    return (
      <>
        {layout.name === 'Grid' ? <FolderGridLayout {...folderProps} /> : <FolderListLayout {...folderProps} />}
        {!onlyOnePage && (
          <button
            className="w-full p-3 text-center"
            onClick={() => setSize(size + 1)}
            disabled={isReachingEnd}
          >
            {isReachingEnd ? t('No more files') : t('Load more')}
          </button>
        )}
        {readmeFile && <MarkdownPreview file={readmeFile} path={path} standalone={false} />}
      </>
    )
  }

  if ('file' in responses[0] && responses.length === 1) {
    const file = responses[0].file as OdFileObject
    const previewType = getPreviewType(getExtension(file.name), { video: Boolean(file.video) })

    if (!previewType) return <DefaultPreview file={file} />

    switch (previewType) {
      case preview.image:
        return <ImagePreview file={file} />
      case preview.text:
        return <TextPreview file={file} />
      case preview.code:
        return <CodePreview file={file} />
      case preview.markdown:
        return <MarkdownPreview file={file} path={path} />
      case preview.video:
        return <VideoPreview file={file} />
      case preview.audio:
        return <AudioPreview file={file} />
      case preview.pdf:
        return <PDFPreview file={file} />
      case preview.office:
        return <OfficePreview file={file} />
      case preview.epub:
        return <EPUBPreview file={file} />
      case preview.url:
        return <URLPreview file={file} />
      default:
        return <DefaultPreview file={file} />
    }
  }

  return <PreviewContainer><FourOhFour errorMsg={t('Cannot preview {{path}}', { path })} /></PreviewContainer>
}

export default FileListing

