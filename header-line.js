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
})();
