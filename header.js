// Malvec Header

document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;

  // Add/remove .scrolled class for frosted-glass effect on scroll
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });

  // Active link tracking
  navbar.querySelectorAll('.nav-links a').forEach(a => {
    a.addEventListener('click', (e) => {
      navbar.querySelectorAll('.nav-links a').forEach(l => l.classList.remove('active'));
      a.classList.add('active');
    });
  });
});


