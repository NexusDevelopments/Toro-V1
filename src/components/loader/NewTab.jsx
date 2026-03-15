import Search from '../SearchContainer';
import QuickLinks from '../QuickLinks';

import { process } from '/src/utils/hooks/loader/utils';

const NewTab = ({ id, updateFn, options = {} }) => {
  const navigating = {
    id: id,
    go: updateFn,
    process: (input) => process(input, false, options.prType || 'auto', options.engine || undefined),
  };

  return (
    <div className="h-[calc(100%-100px)] w-full flex p-6">
      <div className="w-full min-w-0 flex flex-col items-center justify-center">
        <div className="w-full max-w-3xl">
          <Search nav={false} logo={false} cls="w-full relative z-10" navigating={navigating} />
          <QuickLinks cls="mt-8" nav={false} navigating={navigating} />
        </div>
      </div>
    </div>
  );
};

export default NewTab;
