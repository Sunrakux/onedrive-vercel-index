import type { OdFileObject, OdFolderChildren, OdFolderObject } from '../types'
import { ParsedUrlQuery } from 'querystring'
import { FC, MouseEventHandler, SetStateAction, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import toast, { Toaster } from 'react-hot-toast'
import emojiRegex from 'emoji-regex'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { useTranslation } from 'next-i18next'

import useLocalStorage from '../utils/useLocalStorage'
import { getPreviewType, preview } from '../utils/getPreviewType'
import { useProtectedSWRInfinite } from '../utils/fetchWithSWR'
import { getExtension, getRawExtension, getFileIcon } from '../utils/getFileIcon'
import { getStoredToken } from '../utils/protectedRouteHandler'
import {
  DownloadingToast,
  downloadMultipleFiles,
  downloadTreelikeMultipleFiles,
  traverseFolder,
} from './MultiFileDownloader'

import FolderListLayout from './FolderListLayout'
import FolderGridLayout from './FolderGridLayout'

// Dynamic imports for SSR-disabled previews
const EPUBPreview = dynamic(() => import('./previews/EPUBPreview'), { ssr: false })
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

import Loading, { LoadingIcon } from './Loading'
import FourOhFour from './FourOhFour'
import Auth from './Auth'
import { PreviewContainer } from './previews/Containers'
import { layouts } from './SwitchLayout'

const queryToPath = (query?: ParsedUrlQuery) => {
  if (query) {
    const { path } = query
    if (!path) return '/'
    if (typeof path === 'string') return `/${encodeURIComponent(path)}`
    return `/${path.map(p => encodeURIComponent(p)).join('/')}`
  }
  return '/'
}

const renderEmoji = (name: string) => {
  const emoji = emojiRegex().exec(name)
  return { render: emoji && !emoji.index, emoji }
}
const formatChildName = (name: string) => {
  const { render, emoji } = renderEmoji(name)
  return render ? name.replace(emoji ? emoji[0] : '', '').trim() : name
}

export const ChildName: FC<{ name: string; folder?: boolean }> = ({ name, folder }) => {
  const original = formatChildName(name)
  const extension = folder ? '' : getRawExtension(original)
  const prename = folder ? original : original.substring(0, original.length - extension.length)
  return (
    <span className="truncate before:float-right before:content-[attr(data-tail)]" data-tail={extension}>
      {prename}
    </span>
  )
}

export const ChildIcon: FC<{ child: OdFolderChildren }> = ({ child }) => {
  const { render, emoji } = renderEmoji(child.name)
  return render ? <span>{emoji ? emoji[0] : '📁'}</span> : <FontAwesomeIcon icon={child.file ? getFileIcon(child.name, { video: Boolean(child.video) }) : ['far', 'folder']} />
}

export const Checkbox: FC<{ checked: 0 | 1 | 2; onChange: () => void; title: string; indeterminate?: boolean }> = ({ checked, onChange, title, indeterminate }) => {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.checked = Boolean(checked)
      if (indeterminate) ref.current.indeterminate = checked === 1
    }
  }, [checked, indeterminate])
  const handleClick: MouseEventHandler = e => {
    if (ref.current) {
      if (e.target !== ref.current) ref.current.click()
    }
  }
  return (
    <span title={title} className="inline-flex cursor-pointer items-center rounded p-1.5 hover:bg-gray-300 dark:hover:bg-gray-600" onClick={handleClick}>
      <input type="checkbox" value={checked ? '1' : ''} ref={ref} onChange={onChange} aria-label={title} className="form-check-input cursor-pointer" />
    </span>
  )
}

const FileListing: FC<{ query?: ParsedUrlQuery }> = ({ query }) => {
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
  if (!data) return <PreviewContainer><Loading loadingText={t('Loading ...')} /></PreviewContainer>

  const responses: any[] = [].concat(...data)
  const isEmpty = data?.[0]?.length === 0
  const isReachingEnd = isEmpty || typeof data[data.length - 1]?.next === 'undefined'
  const onlyOnePage = typeof data[0]?.next === 'undefined'

  if ('folder' in responses[0]) {
    const folderChildren = [].concat(...responses.map(r => r.folder.value)) as OdFolderObject['value']
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
      setSelected(genTotalSelected(selected) === 2 ? {} : Object.fromEntries(getFiles().map(c => [c.id, true])))
      setTotalSelected(genTotalSelected(selected))
    }

    const handleSelectedDownload = () => {
      const files = getFiles().filter(c => selected[c.id]).map(c => ({
        name: c.name,
        url: `/api/raw/?path=${path}/${encodeURIComponent(c.name)}${hashedToken ? `&odpt=${hashedToken}` : ''}`,
      }))
      if (files.length === 1) {
        if (typeof document !== 'undefined') {
          const el = document.createElement('a')
          el.href = files[0].url
          el.click()
        }
      } else if (files.length > 1) {
        setTotalGenerating(true)
        const toastId = toast.loading(<DownloadingToast router={router} />)
        downloadMultipleFiles({ toastId, router, files })
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

    const handleSelectedPermalink = (baseUrl: string) => {
      return getFiles()
        .filter(c => selected[c.id])
        .map(c => `${baseUrl}/api/raw/?path=${path}/${encodeURIComponent(c.name)}${hashedToken ? `&odpt=${hashedToken}` : ''}`)
        .join('\n')
    }

    const handleFolderDownload = (path: string) => async () => {
      const files = (async function* () {
        for await (const { meta: c, path: p, isFolder, error } of traverseFolder(path)) {
          if (!error) yield { name: c?.name, url: `/api/raw/?path=${p}${hashedToken ? `&odpt=${hashedToken}` : ''}`, path: p, isFolder }
        }
      })()
      const toastId = toast.loading(<DownloadingToast router={router} />)
      downloadTreelikeMultipleFiles({ toastId, router, files }).finally(() => toast.dismiss(toastId))
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

