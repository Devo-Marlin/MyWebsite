// Devon Marlin — shared site behavior: nav, scroll reveal, frame pointer glow, media filter.

document.addEventListener("DOMContentLoaded", function () {
  const header = document.querySelector(".site-header");
  const hamburger = document.getElementById("hamburger");
  const mobilePanel = document.getElementById("mobilePanel");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Header state on scroll */
  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* Mobile menu */
  if (hamburger && mobilePanel) {
    hamburger.addEventListener("click", function () {
      const isOpen = mobilePanel.classList.toggle("is-open");
      hamburger.setAttribute("aria-expanded", String(isOpen));
      document.body.style.overflow = isOpen ? "hidden" : "";
    });

    mobilePanel.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        mobilePanel.classList.remove("is-open");
        hamburger.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
  }

  /* Active nav link */
  const currentPage = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  document.querySelectorAll(".nav-links a").forEach(function (link) {
    const href = (link.getAttribute("href") || "").toLowerCase();
    if (href === currentPage || (currentPage === "" && href === "index.html")) {
      link.classList.add("is-active");
    }
  });

  /* Scroll reveal */
  const revealEls = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    const io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* Pointer-reactive frame glow */
  if (!reduceMotion && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll(".frame").forEach(function (frame) {
      frame.addEventListener("mousemove", function (e) {
        const rect = frame.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        frame.style.setProperty("--px", x + "%");
        frame.style.setProperty("--py", y + "%");
      });
    });
  }

  /* Media gallery filter (Media page only) */
  const filterButtons = document.querySelectorAll("[data-filter]");
  const mediaItems = document.querySelectorAll(".media-item");
  if (filterButtons.length && mediaItems.length) {
    filterButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const category = btn.getAttribute("data-filter");
        filterButtons.forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
        mediaItems.forEach(function (item) {
          const match = category === "all" || item.getAttribute("data-category") === category;
          item.classList.toggle("is-hidden", !match);
        });
      });
    });
  }

  /* Footer year */
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
});
