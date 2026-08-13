(function () {
  function splitHeaderCategoryNames() {
    if (window.innerWidth < 768) return;

    const categoryNames = document.querySelectorAll(
      '#navigation .menu-level-1 > li > a > b'
    );

    categoryNames.forEach(function (categoryName) {
      if (categoryName.dataset.wordsSplit === 'true') return;

      const originalText = categoryName.textContent.trim();
      const words = originalText.split(/\s+/).filter(Boolean);

      if (words.length < 2) return;

      categoryName.textContent = '';
      categoryName.classList.add('category-word-lines');
      categoryName.dataset.wordsSplit = 'true';
      categoryName.setAttribute('aria-label', originalText);

      words.forEach(function (word) {
        const wordElement = document.createElement('span');
        wordElement.textContent = word;
        wordElement.setAttribute('aria-hidden', 'true');

        categoryName.appendChild(wordElement);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', splitHeaderCategoryNames);
  document.addEventListener('ShoptetDOMContentLoaded', splitHeaderCategoryNames);

  const observer = new MutationObserver(splitHeaderCategoryNames);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // The dklab "obľúbené" (wishlist) addon injects #dkLabFavHeaderWrapper as
  // its own standalone element, NOT as a child of .navigation-buttons -- so
  // CSS order/flex rules on it do nothing (order only works among flex
  // siblings in the same container). Physically move it into
  // .navigation-buttons, right before the cart icon, so it actually becomes
  // part of that row instead of sitting separately.
  function moveFavIntoNavButtons() {
    const wrapper = document.getElementById('dkLabFavHeaderWrapper');
    const navButtons = document.querySelector('.navigation-buttons');
    if (!wrapper || !navButtons || navButtons.contains(wrapper)) return;

    const cartLink = navButtons.querySelector('a[data-target="cart"]');
    if (cartLink) {
      navButtons.insertBefore(wrapper, cartLink);
    } else {
      navButtons.appendChild(wrapper);
    }
  }

  document.addEventListener('DOMContentLoaded', moveFavIntoNavButtons);
  document.addEventListener('ShoptetDOMContentLoaded', moveFavIntoNavButtons);

  const favObserver = new MutationObserver(moveFavIntoNavButtons);
  favObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // MOBILE SEARCH: Shoptet's native mobile search toggle expands the search
  // form INLINE in the icon row when the magnifier is tapped, squeezing/
  // covering the other header icons (login/heart/cart) -- confirmed live via
  // screenshots 2026-08-13. Requested fix: tapping the magnifier must instead
  // open a NEW full-width row BELOW the icon row, leaving the icon row itself
  // untouched, and that row must not exist in the DOM/layout at all when
  // inactive (no leftover empty space).
  //
  // Takes full manual control of the click instead of trying to detect
  // Shoptet's own internal toggle class (unknown/unstable) -- capture-phase
  // listener + stopImmediatePropagation() so the native inline-expand
  // behavior never runs at all, only ours does.
  function setupMobileSearchRow() {
    if (window.innerWidth >= 768) return;

    const searchToggle = document.querySelector('.navigation-buttons a[data-target="search"]');
    const headerTopWrapper = document.querySelector('#header .header-top-wrapper');
    const searchBlock = document.querySelector('#header .search');
    if (!searchToggle || !headerTopWrapper || !searchBlock) return;
    if (searchToggle.dataset.vipSearchWired) return;
    searchToggle.dataset.vipSearchWired = '1';

    let row = document.getElementById('vip-mobile-search-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'vip-mobile-search-row';
      headerTopWrapper.insertAdjacentElement('afterend', row);
    }
    row.appendChild(searchBlock);

    function openSearchRow() {
      row.classList.add('vip-active');
      const input = searchBlock.querySelector('.js-search-input');
      if (input) input.focus();
    }

    function closeSearchRow() {
      row.classList.remove('vip-active');
    }

    searchToggle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (row.classList.contains('vip-active')) {
        closeSearchRow();
      } else {
        openSearchRow();
      }
    }, true);

    // Klik mimo otevřený řádek ho zavře.
    document.addEventListener('click', function (event) {
      if (!row.classList.contains('vip-active')) return;
      if (row.contains(event.target) || searchToggle.contains(event.target)) return;
      closeSearchRow();
    });
  }

  document.addEventListener('DOMContentLoaded', setupMobileSearchRow);
  document.addEventListener('ShoptetDOMContentLoaded', setupMobileSearchRow);

  const searchObserver = new MutationObserver(setupMobileSearchRow);
  searchObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
