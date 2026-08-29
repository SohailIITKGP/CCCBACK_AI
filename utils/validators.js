const validateEmail = (email) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  };
  
  const validatePhoneNumber = (number) => {
    const regex = /^[0-9]{10}$/;
    return regex.test(number);
  };
  
  module.exports = { validateEmail, validatePhoneNumber };
  