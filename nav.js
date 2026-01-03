const closeMenu = (nav, toggle) => {
  nav.classList.remove("mlr-nav--open");
  toggle.setAttribute("aria-expanded", "false");
};

const initNavToggle = () => {
  const toggles = document.querySelectorAll("[data-mlr-nav-toggle]");
  if (!toggles.length) {
    return;
  }

  toggles.forEach((toggle) => {
    const nav = toggle.closest(".mlr-nav");
    if (!nav) {
      return;
    }
    const links = nav.querySelector("[data-mlr-nav-links]");
    if (!links) {
      return;
    }

    toggle.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("mlr-nav--open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    links.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.closest("a")) {
        closeMenu(nav, toggle);
      }
    });

    const mediaQuery = window.matchMedia("(max-width: 960px)");
    const handleChange = () => {
      if (!mediaQuery.matches) {
        closeMenu(nav, toggle);
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNavToggle, { once: true });
} else {
  initNavToggle();
}
