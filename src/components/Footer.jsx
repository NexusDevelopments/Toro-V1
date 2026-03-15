import { Bookmark } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import Disc from './Discord';
import clsx from 'clsx';
import BookmarksModal from './Bookmarks';

const Footer = memo(() => {
  const [isBookmarksOpen, setIsBookmarksOpen] = useState(false);

  const handleDs = useCallback(() => {
    window.open('/ds', '_blank');
  }, []);

  const handleAboutBlank = useCallback(() => {
    import('/src/utils/utils.js').then(({ openAboutBlankPopup }) => openAboutBlankPopup(true));
  }, []);

  return (
    <div className="w-full fixed bottom-0 flex items-end justify-between p-2">
      <div />
      <div className="flex gap-2 items-center">
        <div
          className={clsx(
            'flex gap-1 items-center cursor-pointer',
            'hover:-translate-y-0.5 duration-200',
          )}
          onClick={handleAboutBlank}
        >
          about:blank
        </div>
        <span className="text-gray-500">•</span>
        <div
          className={clsx(
            'flex gap-1 items-center cursor-pointer',
            'hover:-translate-y-0.5 duration-200',
          )}
          onClick={handleDs}
        >
          <Disc className="w-4" fill="#f4d4d8" />
          Discord
        </div>
        <span className="text-gray-500">•</span>
        <div
          className={clsx(
            'flex gap-1 items-center cursor-pointer',
            'hover:-translate-y-0.5 duration-200',
          )}
          onClick={() => setIsBookmarksOpen(true)}
        >
          <Bookmark className="w-4" />
          Bookmarks
        </div>
      </div>
      <BookmarksModal isOpen={isBookmarksOpen} onClose={() => setIsBookmarksOpen(false)} />
    </div>
  );
});

Footer.displayName = 'Footer';
export default Footer;
